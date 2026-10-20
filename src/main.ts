import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { formatComment, postComment } from "./comment.ts";
import { formatBytes, formatDuration } from "./formatBytes.ts";
import {
  appendHistory,
  backfillCommits,
  historyEntry,
  historyFileFor,
  mergeEntries,
  readHistory,
  remoteTags,
} from "./history.ts";
import { formatHistory } from "./historyChart.ts";
import { measure } from "./measure.ts";
import { run } from "./run.ts";
import { assertCompressionSupported, diskSizes, serve } from "./serve.ts";
import {
  addBaseWorktree,
  baseComparisonBlocker,
  removeBaseWorktree,
} from "./workspaceGit.ts";

import type {
  BaseRef,
  BuiltResult,
  Config,
  HistoryEntry,
  JourneyStep,
  RowResult,
} from "./types.ts";

/**
 * read an action input (the INPUT_* convention used by github actions).
 * An empty string counts as explicitly set when allowEmpty is given - eg
 * build-command "" means "skip the build", not "use the default"
 */
const input = (
  name: string,
  fallback: string,
  { allowEmpty = false }: { allowEmpty?: boolean } = {},
) => {
  const v = process.env[`INPUT_${name.toUpperCase().replaceAll("-", "_")}`];
  if (v === undefined) return fallback;
  if (v === "" && !allowEmpty) return fallback;
  return v;
};

/** build a checkout and measure all scenarios against its served output */
const buildAndMeasure = async (
  checkoutDir: string,
  config: Config,
): Promise<BuiltResult> => {
  if (config.installCommand) run(config.installCommand, checkoutDir);
  if (config.buildCommand) run(config.buildCommand, checkoutDir);
  const serveDir = resolve(checkoutDir, config.serveDir);
  if (!existsSync(serveDir)) {
    throw new Error(`serve-dir does not exist after build: ${serveDir}`);
  }
  // the whole-site weight on disk (every file, loaded or not), compressed as
  // served - the complement to the loaded-to-ready bytes the browser measures
  const disk =
    config.measureDisk ?
      diskSizes(serveDir, config.compression, config.compressionLevel)
    : null;
  const server = await serve(serveDir, config.compression, config.compressionLevel);
  try {
    const steps = config.steps.map((s) =>
      s.goto !== undefined ?
        { ...s, goto: new URL(s.goto, server.origin).href }
      : s,
    );
    const results = await measure(steps, config);
    // the browser must actually be able to decode the requested compression;
    // otherwise it received the uncompressed fallback and the numbers are wrong
    server.assertBrowserDecodes();
    return { results, disk };
  } finally {
    await server.close();
  }
};

const main = async () => {
  // a journey is the full step language; the simpler `scenarios` input is
  // sugar for goto/row pairs
  const journeyInput = input("journey", "");
  const scenarios = JSON.parse(input("scenarios", "[]")) as {
    url: string;
    name?: string;
    mark?: string;
    emoji?: string;
  }[];
  const scenarioSugar: JourneyStep[] = scenarios.flatMap((s, i) => [
    { goto: s.url },
    { row: s.name ?? `scenario ${i + 1}`, mark: s.mark, emoji: s.emoji },
  ]);
  const config: Config = {
    steps: journeyInput ? JSON.parse(journeyInput) : scenarioSugar,
    installCommand: input("install-command", "", { allowEmpty: true }),
    buildCommand: input("build-command", "npm run build", { allowEmpty: true }),
    cleanCommand: input("clean-command", ""),
    serveDir: input("serve-dir", "dist"),
    compression: input("compression", "gzip"),
    // null = use the encoding's default (gzip 8, br 4, zstd 6); otherwise a
    // number or the string "max" (resolved to the codec's maximum in serve)
    compressionLevel: (() => {
      const raw = input("compression-level", "").trim().toLowerCase();
      return raw === "" ? null : raw;
    })(),
    runs: Number(input("runs", "2")),
    stepTimeoutMs: Number(input("step-timeout-ms", "20000")),
    settleTimeoutMs: Number(input("settle-timeout-ms", "30000")),
    timeoutMs: Number(input("timeout-ms", "900000")),
    ignorePatterns: JSON.parse(input("ignore-url-patterns", "[]")),
    // fetch()es made with priority "low" are logged but not counted
    ignoreLowPriority: input("ignore-low-priority", "false") === "true",
    settleMs: Number(input("settle-ms", "1500")),
    markTimeoutMs: Number(input("mark-timeout-ms", "60000")),
    baseRefs: JSON.parse(input("base-refs", "[]")),
    commentKey: input("comment-key", ""),
    spreadToleranceBytes: Number(input("spread-tolerance-bytes", "512")),
    // same name, semantics and default as compressed-size-action: changes
    // below this many bytes display as unchanged
    minimumChangeThreshold: Number(input("minimum-change-threshold", "1")),
    stripHash: input("strip-hash", "(-[a-zA-Z0-9_-]{8})\\.", {
      allowEmpty: true,
    }),
    comment: input("comment", "true") === "true",
    // PR to comment on; empty falls back to the triggering event's PR (so a
    // push-to-main run can target an open release PR)
    prNumber: input("pr-number", ""),
    // collapse the per-file breakdown into expandable <details> (true) or show
    // it inline (false); unchanged rows are always a plain line either way
    collapsibleBreakdown: input("collapse-breakdown", "true") === "true",
    // also report the total built size on disk (every file, compressed as
    // served). Off skips compressing the whole site - cheaper on large builds
    measureDisk: input("measure-disk", "true") === "true",
    // per-commit history on an orphan branch, charted in the comment
    historyBranch: input("history-branch", ""),
    historyLength: Number(input("history-length", "30")),
    backfill: input("backfill", ""),
    token: input("github-token", process.env["GITHUB_TOKEN"] ?? ""),
  };
  if (config.backfill && !config.historyBranch) {
    throw new Error("backfill needs a history-branch to record into");
  }
  if (config.steps.length === 0) {
    throw new Error(
      "nothing to measure - set the `journey` or `scenarios` input",
    );
  }
  // fail fast on a bad/unsupported compression choice or out-of-range level,
  // before any expensive build runs (zstd needs Node >= 22.15)
  assertCompressionSupported(config.compression, config.compressionLevel);

  // whole-process watchdog: the individual waits are all capped, but this
  // guarantees that nothing - including bugs in this action - can hang a ci
  // job indefinitely. unref so the pending timer cannot itself keep the
  // process alive after a successful finish
  setTimeout(() => {
    console.error(
      `[true-site-size] hard timeout: the whole action did not finish within ${config.timeoutMs}ms (timeout-ms input) - failing rather than hanging`,
    );
    process.exit(1);
  }, config.timeoutMs).unref();

  const workspace = process.env["GITHUB_WORKSPACE"] ?? process.cwd();

  // decided before anything is built, so the run says up front that it will
  // report head alone - and, more to the point, so a workspace that must not
  // be written to is never cleaned or worktree'd into
  const baseSkippedReason = baseComparisonBlocker(workspace);
  if (baseSkippedReason) {
    console.warn(
      `[true-site-size] base comparison skipped: ${baseSkippedReason}`,
    );
  }

  const logBreakdown = (label: string, results: RowResult[]) => {
    for (const r of results) {
      if (r.error) {
        console.log(`[true-site-size] ${label} / ${r.name}: ${r.error}`);
        continue;
      }
      console.log(
        `[true-site-size] ${label} / ${r.name}: ${formatBytes(r.bytes)} over ${r.requests} requests, mark at ${formatDuration(r.timeToMarkMs)} (per-request breakdown follows, largest first)`,
      );
      const sorted = [...(r.requestLog ?? [])].sort((a, b) => b.bytes - a.bytes);
      for (const { url, bytes, atMs, ignored, lowPriority } of sorted) {
        if (ignored) {
          console.log(
            `  ${formatBytes(bytes).padStart(9)}  at ${String(atMs).padStart(6)}ms  ${url}  [${lowPriority ? "low priority" : "ignored"} - not counted]`,
          );
          continue;
        }
        console.log(
          `  ${formatBytes(bytes).padStart(9)}  at ${String(atMs).padStart(6)}ms  ${url}`,
        );
      }
    }
  };

  // every base ref shares the measurement config, so they share a cache key;
  // the base sha distinguishes them on disk. The cache dir is persisted between
  // runs by actions/cache (see action.yml), so repeat pushes to a pr skip the
  // expensive rebuild of each unchanged base.
  const configHash = createHash("sha256")
    .update(
      JSON.stringify({
        // `chart` only picks what the history draws, not what's measured
        steps: config.steps.map(({ chart: _, ...step }) => step),
        compression: config.compression,
        compressionLevel: config.compressionLevel,
        runs: config.runs,
        settleMs: config.settleMs,
        ignorePatterns: config.ignorePatterns,
        ignoreLowPriority: config.ignoreLowPriority,
        serveDir: config.serveDir,
        buildCommand: config.buildCommand,
        // part of what's measured, and bumping it re-keys the cache so the
        // pre-disk array-shaped entries are never read back
        measureDisk: config.measureDisk,
      }),
    )
    .digest("hex")
    .slice(0, 16);
  const cacheDir =
    process.env["TRUE_SITE_SIZE_CACHE_DIR"] ??
    (process.env["GITHUB_ACTIONS"] ?
      join(homedir(), ".true-site-size-cache")
    : null);

  // clear head's build state from the workspace before the first base build.
  // each base checks out into a worktree *inside* the workspace, so node's
  // upward module resolution (and npm's ancestor node_modules/.bin) would
  // otherwise let a base build silently inherit head's installed deps - leaking
  // head into the base measurement. Run once: once removed it stays removed.
  // eg clean-command: pnpm clean
  let cleaned = false;
  const cleanOnce = () => {
    if (config.cleanCommand && !cleaned) {
      run(config.cleanCommand, workspace);
      cleaned = true;
    }
  };

  // the github event payload supplies the PR's base ref (the default to
  // compare against) and its number (for commenting)
  const eventPath = process.env["GITHUB_EVENT_PATH"];
  const event =
    eventPath && existsSync(eventPath) ?
      JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(eventPath, "utf8")))
    : {};
  const defaultBranch: string = event.repository?.default_branch ?? "main";
  const historyFile = historyFileFor(config.commentKey);

  /**
   * measure each commit the backfill spec names into the history, newest
   * first. Commits already recorded under this config are skipped and each
   * result is pushed as soon as it's measured, so a run cut short - or several
   * runs sharing a long range - pick up where the last left off. A commit that
   * can't be built (too old for today's toolchain, or from before the app
   * emitted its marks) is recorded as an error, not retried on every run.
   */
  const backfill = async () => {
    const commits = backfillCommits(workspace, config.backfill, defaultBranch);
    const recorded = new Set(
      readHistory(workspace, config.historyBranch, historyFile)
        .filter((e) => e.configHash === configHash)
        .map((e) => e.sha),
    );
    const todo = commits.filter((sha) => !recorded.has(sha));
    console.log(
      `[true-site-size] backfill: ${commits.length} commit(s) in "${config.backfill}", ${commits.length - todo.length} already recorded, ${todo.length} to measure`,
    );
    const started = Date.now();
    let slowestMs = 0;
    for (const [i, sha] of todo.entries()) {
      // stop cleanly rather than have the watchdog kill a half-measured commit
      if (slowestMs && Date.now() - started + slowestMs * 1.2 > config.timeoutMs) {
        console.warn(
          `[true-site-size] backfill: stopping with ${todo.length - i} commit(s) left - another would likely overrun timeout-ms. Run the backfill again to continue`,
        );
        break;
      }
      const commitStarted = Date.now();
      console.log(
        `[true-site-size] backfill ${i + 1}/${todo.length}: measuring ${sha.slice(0, 9)}...`,
      );
      cleanOnce();
      const dir = join(workspace, ".true-site-size-base");
      let entry: HistoryEntry;
      try {
        addBaseWorktree(workspace, dir, sha);
        const built = await buildAndMeasure(dir, config);
        logBreakdown(`backfill ${sha.slice(0, 9)}`, built.results);
        entry = historyEntry(workspace, sha, configHash, built);
      } catch (e) {
        console.warn(
          `[true-site-size] backfill: ${sha.slice(0, 9)} could not be measured (recorded as an error): ${(e as Error).message}`,
        );
        entry = historyEntry(workspace, sha, configHash, {
          error: (e as Error).message,
        });
      } finally {
        removeBaseWorktree(workspace, dir);
      }
      appendHistory(workspace, config.historyBranch, historyFile, [entry]);
      slowestMs = Math.max(slowestMs, Date.now() - commitStarted);
    }
  };

  if (config.backfill) {
    if (baseSkippedReason) {
      throw new Error(`backfill needs a usable git workspace: ${baseSkippedReason}`);
    }
    await backfill();
    return;
  }

  console.log("[true-site-size] measuring head...");
  const { results: head, disk: headDisk } = await buildAndMeasure(workspace, config);
  logBreakdown("head", head);
  if (headDisk) {
    console.log(
      `[true-site-size] head total built size on disk: ${formatBytes(headDisk.total)} over ${Object.keys(headDisk.files).length} files`,
    );
  }

  const prBase = event.pull_request?.base?.ref;
  // explicit base-refs, else the PR base as a single ref. Each is measured and
  // shown as its own column. Outside a PR (or with neither), or where the
  // workspace bars measuring a base at all, head stands alone.
  const compareRefs =
    baseSkippedReason ? []
    : config.baseRefs.length ? config.baseRefs
    : prBase ? [prBase]
    : [];

  const serverUrl = process.env["GITHUB_SERVER_URL"];
  const repo = process.env["GITHUB_REPOSITORY"];

  /** fetch, identify and measure one base ref; never throws */
  const measureBaseRef = async (ref: string): Promise<BaseRef> => {
    const base: BaseRef = { ref, sha: null, describe: null, url: null };

    // resolve the ref first: a bad ref name or fetch failure marks just this
    // column rather than failing the whole run. --tags + a bounded depth let
    // `git describe` name the ref relative to the nearest release tag (eg
    // main -> v1.4.0-4-gabc123); the build only needs the tip
    try {
      run(`git fetch --tags --depth=100 origin ${ref}`, workspace);
      base.sha = execSync("git rev-parse FETCH_HEAD", { cwd: workspace })
        .toString()
        .trim();
    } catch {
      console.warn(`[true-site-size] could not fetch base ref "${ref}"`);
      base.error = `could not fetch ref "${ref}" - does it exist on origin?`;
      base.results = null;
      base.disk = null;
      return base;
    }
    try {
      base.describe = execSync("git describe --tags FETCH_HEAD", {
        cwd: workspace,
      })
        .toString()
        .trim();
    } catch {
      // no tag reachable within the fetched history - the linked sha stands in
    }
    base.url =
      serverUrl && repo ? `${serverUrl}/${repo}/commit/${base.sha}` : null;

    const cacheFile =
      cacheDir ? join(cacheDir, `base-${base.sha}-${configHash}.json`) : null;
    // the cache holds { results, disk }; a bare array is a pre-disk entry the
    // configHash bump should already exclude, but tolerate it as a miss
    const cached =
      cacheFile && existsSync(cacheFile) ?
        JSON.parse(readFileSync(cacheFile, "utf8"))
      : null;
    if (cached && !Array.isArray(cached)) {
      base.results = cached.results;
      base.disk = cached.disk ?? null;
      console.log(
        `[true-site-size] base (${ref} @ ${base.sha.slice(0, 9)}) loaded from cache - skipping its build and measurement`,
      );
      logBreakdown(`base ${ref} (cached)`, base.results!);
      return base;
    }

    console.log(`[true-site-size] measuring base (${ref})...`);
    cleanOnce();
    const baseDir = join(workspace, ".true-site-size-base");
    try {
      addBaseWorktree(workspace, baseDir, "FETCH_HEAD");
      const built = await buildAndMeasure(baseDir, config);
      base.results = built.results;
      base.disk = built.disk;
      logBreakdown(`base ${ref}`, base.results);
      // only cache fully-successful measurements: an error row (eg a missing
      // mark, or a flaky run) must not persist for this sha
      if (cacheFile && base.results.every((r) => !r.error)) {
        mkdirSync(cacheDir!, { recursive: true });
        writeFileSync(
          cacheFile,
          JSON.stringify({ results: base.results, disk: base.disk }),
        );
        console.log("[true-site-size] base result cached for future runs");
      }
    } catch (e) {
      console.warn(
        `[true-site-size] base ${ref} could not be measured (its column will say so): ${(e as Error).message}`,
      );
      base.error = (e as Error).message;
      base.results = null;
      base.disk = null;
    } finally {
      removeBaseWorktree(workspace, baseDir);
    }
    return base;
  };

  const bases: BaseRef[] = [];
  for (const ref of compareRefs) {
    bases.push(await measureBaseRef(ref));
  }

  // history: a push to the default branch records its head; every run charts
  // the recorded commits, a PR's head joining them as the newest point.
  // History is optional garnish on the report, so its failures only warn
  let historySection = "";
  if (config.historyBranch && !baseSkippedReason) {
    try {
      const sha = process.env["GITHUB_SHA"];
      const isDefaultPush =
        process.env["GITHUB_EVENT_NAME"] === "push" &&
        process.env["GITHUB_REF"] === `refs/heads/${defaultBranch}`;
      const headEntry =
        sha ?
          historyEntry(workspace, sha, configHash, { results: head, disk: headDisk })
        : null;
      let entries = readHistory(workspace, config.historyBranch, historyFile);
      if (isDefaultPush && headEntry) {
        appendHistory(workspace, config.historyBranch, historyFile, [headEntry]);
        entries = mergeEntries(entries, [headEntry]);
      }
      historySection = formatHistory(entries, isDefaultPush ? null : headEntry, {
        configHash,
        length: config.historyLength,
        tags: remoteTags(workspace),
        defaultBranch,
        commitUrl: (s) => (serverUrl && repo ? `${serverUrl}/${repo}/commit/${s}` : null),
        prUrl: (n) => (serverUrl && repo ? `${serverUrl}/${repo}/pull/${n}` : null),
        headLabel: event.pull_request ? "this PR" : "head",
        commentKey: config.commentKey,
        charted: {
          visits: new Set(head.filter((r) => r.visitChart).map((r) => r.visit ?? 0)),
          rows: new Set(head.filter((r) => r.chart).map((r) => r.name)),
        },
      });
    } catch (e) {
      console.warn(`[true-site-size] history unavailable: ${(e as Error).message}`);
    }
  }

  const runUrl =
    process.env["GITHUB_RUN_ID"] ?
      `${process.env["GITHUB_SERVER_URL"]}/${process.env["GITHUB_REPOSITORY"]}/actions/runs/${process.env["GITHUB_RUN_ID"]}`
    : undefined;
  const body = formatComment(head, bases, {
    runUrl,
    commentKey: config.commentKey,
    stripHash: config.stripHash,
    spreadToleranceBytes: config.spreadToleranceBytes,
    minimumChangeThreshold: config.minimumChangeThreshold,
    collapsibleBreakdown: config.collapsibleBreakdown,
    headDisk,
    measureDisk: config.measureDisk,
    baseSkippedReason,
    historySection,
  });
  console.log(body);

  // an explicit pr-number wins (eg a push-to-main run updating an open release
  // PR); otherwise comment on the PR that triggered the run
  const issueNumber = config.prNumber ? Number(config.prNumber) : event.pull_request?.number;
  if (config.comment && issueNumber && config.token) {
    await postComment(body, {
      token: config.token,
      repo: process.env["GITHUB_REPOSITORY"]!,
      issueNumber,
      commentKey: config.commentKey,
      apiUrl: process.env["GITHUB_API_URL"] ?? "https://api.github.com",
    });
    console.log("[true-site-size] comment posted");
  }

  // expose results for downstream steps
  const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
  if (summaryPath) {
    await import("node:fs").then((fs) => fs.appendFileSync(summaryPath, body));
  }

  // also write the comment markdown to an explicit file when asked. Useful for
  // local runs (eg via act, where GITHUB_STEP_SUMMARY is inside the container
  // and not readable on the host) that want to read the report back out.
  const outputFile = process.env["TRUE_SITE_SIZE_OUTPUT_FILE"];
  if (outputFile) {
    writeFileSync(outputFile, body);
  }
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
