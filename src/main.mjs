import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { formatComment, postComment } from "./comment.mjs";
import { formatBytes, formatDuration } from "./formatBytes.mjs";
import { measure } from "./measure.mjs";
import { assertCompressionSupported, serve } from "./serve.mjs";

/**
 * read an action input (the INPUT_* convention used by github actions).
 * An empty string counts as explicitly set when allowEmpty is given - eg
 * build-command "" means "skip the build", not "use the default"
 */
const input = (name, fallback, { allowEmpty = false } = {}) => {
  const v = process.env[`INPUT_${name.toUpperCase().replaceAll("-", "_")}`];
  if (v === undefined) return fallback;
  if (v === "" && !allowEmpty) return fallback;
  return v;
};

const run = (cmd, cwd) => {
  console.log(`[true-site-size] $ ${cmd} (in ${cwd})`);
  execSync(cmd, { cwd, stdio: "inherit" });
};

/** build a checkout and measure all scenarios against its served output */
const buildAndMeasure = async (checkoutDir, config) => {
  if (config.installCommand) run(config.installCommand, checkoutDir);
  if (config.buildCommand) run(config.buildCommand, checkoutDir);
  const serveDir = resolve(checkoutDir, config.serveDir);
  if (!existsSync(serveDir)) {
    throw new Error(`serve-dir does not exist after build: ${serveDir}`);
  }
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
    return results;
  } finally {
    await server.close();
  }
};

const main = async () => {
  // a journey is the full step language; the simpler `scenarios` input is
  // sugar for goto/row pairs
  const journeyInput = input("journey", "");
  const scenarioSugar = JSON.parse(input("scenarios", "[]")).flatMap(
    (s, i) => [
      { goto: s.url },
      { row: s.name ?? `scenario ${i + 1}`, mark: s.mark },
    ],
  );
  const config = {
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
    // collapse the per-file breakdown into expandable <details> (true) or show
    // it inline (false); unchanged rows are always a plain line either way
    collapsibleBreakdown: input("collapse-breakdown", "true") === "true",
    token: input("github-token", process.env.GITHUB_TOKEN ?? ""),
  };
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

  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();

  const logBreakdown = (label, results) => {
    for (const r of results) {
      if (r.error) {
        console.log(`[true-site-size] ${label} / ${r.name}: ${r.error}`);
        continue;
      }
      console.log(
        `[true-site-size] ${label} / ${r.name}: ${formatBytes(r.bytes)} over ${r.requests} requests, mark at ${formatDuration(r.timeToMarkMs)} (per-request breakdown follows, largest first)`,
      );
      const sorted = [...(r.requestLog ?? [])].sort((a, b) => b.bytes - a.bytes);
      for (const { url, bytes, atMs, ignored } of sorted) {
        if (ignored) {
          console.log(
            `  ${formatBytes(bytes).padStart(9)}  at ${String(atMs).padStart(6)}ms  ${url}  [ignored - not counted]`,
          );
          continue;
        }
        console.log(
          `  ${formatBytes(bytes).padStart(9)}  at ${String(atMs).padStart(6)}ms  ${url}`,
        );
      }
    }
  };

  console.log("[true-site-size] measuring head...");
  const head = await buildAndMeasure(workspace, config);
  logBreakdown("head", head);

  // the github event payload supplies the PR's base ref (the default to
  // compare against) and its number (for commenting)
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const event =
    eventPath && existsSync(eventPath) ?
      JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(eventPath, "utf8")))
    : {};
  const prBase = event.pull_request?.base?.ref;
  // explicit base-refs, else the PR base as a single ref. Each is measured and
  // shown as its own column. Outside a PR (or with neither) head stands alone.
  const compareRefs =
    config.baseRefs.length ? config.baseRefs
    : prBase ? [prBase]
    : [];

  const serverUrl = process.env.GITHUB_SERVER_URL;
  const repo = process.env.GITHUB_REPOSITORY;

  // every base ref shares the measurement config, so they share a cache key;
  // the base sha distinguishes them on disk. The cache dir is persisted between
  // runs by actions/cache (see action.yml), so repeat pushes to a pr skip the
  // expensive rebuild of each unchanged base.
  const configHash = createHash("sha256")
    .update(
      JSON.stringify({
        steps: config.steps,
        compression: config.compression,
        compressionLevel: config.compressionLevel,
        runs: config.runs,
        settleMs: config.settleMs,
        ignorePatterns: config.ignorePatterns,
        serveDir: config.serveDir,
        buildCommand: config.buildCommand,
      }),
    )
    .digest("hex")
    .slice(0, 16);
  const cacheDir =
    process.env.TRUE_SITE_SIZE_CACHE_DIR ??
    (process.env.GITHUB_ACTIONS ?
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

  /** fetch, identify and measure one base ref; never throws */
  const measureBaseRef = async (ref) => {
    const base = { ref, sha: null, describe: null, url: null };

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
    if (cacheFile && existsSync(cacheFile)) {
      base.results = JSON.parse(readFileSync(cacheFile, "utf8"));
      console.log(
        `[true-site-size] base (${ref} @ ${base.sha.slice(0, 9)}) loaded from cache - skipping its build and measurement`,
      );
      logBreakdown(`base ${ref} (cached)`, base.results);
      return base;
    }

    console.log(`[true-site-size] measuring base (${ref})...`);
    cleanOnce();
    const baseDir = join(workspace, ".true-site-size-base");
    rmSync(baseDir, { recursive: true, force: true });
    try {
      run(`git worktree add --detach ${baseDir} FETCH_HEAD`, workspace);
      base.results = await buildAndMeasure(baseDir, config);
      logBreakdown(`base ${ref}`, base.results);
      // only cache fully-successful measurements: an error row (eg a missing
      // mark, or a flaky run) must not persist for this sha
      if (cacheFile && base.results.every((r) => !r.error)) {
        mkdirSync(cacheDir, { recursive: true });
        writeFileSync(cacheFile, JSON.stringify(base.results));
        console.log("[true-site-size] base result cached for future runs");
      }
    } catch (e) {
      console.warn(
        `[true-site-size] base ${ref} could not be measured (its column will say so): ${e.message}`,
      );
      base.error = e.message;
      base.results = null;
    } finally {
      // remove the worktree if it was added; ignore if it never existed
      try {
        run(`git worktree remove --force ${baseDir}`, workspace);
      } catch {
        // no worktree to remove (eg add failed) - nothing to clean up
      }
    }
    return base;
  };

  const bases = [];
  for (const ref of compareRefs) {
    bases.push(await measureBaseRef(ref));
  }

  const runUrl =
    process.env.GITHUB_RUN_ID ?
      `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : undefined;
  const body = formatComment(head, bases, {
    runUrl,
    commentKey: config.commentKey,
    stripHash: config.stripHash,
    spreadToleranceBytes: config.spreadToleranceBytes,
    minimumChangeThreshold: config.minimumChangeThreshold,
    collapsibleBreakdown: config.collapsibleBreakdown,
  });
  console.log(body);

  const issueNumber = event.pull_request?.number;
  if (config.comment && issueNumber && config.token) {
    await postComment(body, {
      token: config.token,
      repo: process.env.GITHUB_REPOSITORY,
      issueNumber,
      commentKey: config.commentKey,
      apiUrl: process.env.GITHUB_API_URL ?? "https://api.github.com",
    });
    console.log("[true-site-size] comment posted");
  }

  // expose results for downstream steps
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    await import("node:fs").then((fs) => fs.appendFileSync(summaryPath, body));
  }

  // also write the comment markdown to an explicit file when asked. Useful for
  // local runs (eg via act, where GITHUB_STEP_SUMMARY is inside the container
  // and not readable on the host) that want to read the report back out.
  const outputFile = process.env.TRUE_SITE_SIZE_OUTPUT_FILE;
  if (outputFile) {
    writeFileSync(outputFile, body);
  }
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
