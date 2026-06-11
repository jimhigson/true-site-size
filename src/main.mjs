import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { formatComment, postComment } from "./comment.mjs";
import { formatBytes, formatDuration } from "./formatBytes.mjs";
import { measure } from "./measure.mjs";
import { serve } from "./serve.mjs";

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
  const server = await serve(serveDir, config.compression);
  try {
    const steps = config.steps.map((s) =>
      s.goto !== undefined ?
        { ...s, goto: new URL(s.goto, server.origin).href }
      : s,
    );
    return await measure(steps, config);
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
    serveDir: input("serve-dir", "dist"),
    compression: input("compression", "gzip"),
    runs: Number(input("runs", "2")),
    stepTimeoutMs: Number(input("step-timeout-ms", "20000")),
    settleTimeoutMs: Number(input("settle-timeout-ms", "30000")),
    timeoutMs: Number(input("timeout-ms", "900000")),
    ignorePatterns: JSON.parse(input("ignore-url-patterns", "[]")),
    settleMs: Number(input("settle-ms", "1500")),
    markTimeoutMs: Number(input("mark-timeout-ms", "60000")),
    baseRef: input("base-ref", ""),
    commentKey: input("comment-key", ""),
    comment: input("comment", "true") === "true",
    token: input("github-token", process.env.GITHUB_TOKEN ?? ""),
  };
  if (config.steps.length === 0) {
    throw new Error(
      "nothing to measure - set the `journey` or `scenarios` input",
    );
  }

  // whole-process watchdog: the individual waits are all capped, but this
  // guarantees that nothing - including bugs in this action - can hang a ci
  // job indefinitely
  setTimeout(() => {
    console.error(
      `[true-site-size] hard timeout: the whole action did not finish within ${config.timeoutMs}ms (timeout-ms input) - failing rather than hanging`,
    );
    process.exit(1);
  }, config.timeoutMs);

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

  // resolve the ref to compare against: explicit base-ref input, else the
  // PR's base. Outside a PR (or with neither available) head is reported
  // alone.
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const event =
    eventPath && existsSync(eventPath) ?
      JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(eventPath, "utf8")))
    : {};
  const prBase = event.pull_request?.base?.ref;
  const compareRef = config.baseRef || prBase;

  let base = null;
  let baseLabel = "—";
  if (compareRef) {
    baseLabel = `\`${compareRef}\``;
    run(`git fetch --no-tags --depth=1 origin ${compareRef}`, workspace);
    const baseSha = execSync("git rev-parse FETCH_HEAD", { cwd: workspace })
      .toString()
      .trim();

    // base results are cached by (base sha, measurement config): the same
    // base is typically re-measured on every push to a pr, and rebuilding it
    // each time is the expensive half of the job. The cache dir is persisted
    // between runs by actions/cache (see action.yml)
    const configHash = createHash("sha256")
      .update(
        JSON.stringify({
          steps: config.steps,
          compression: config.compression,
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
    const cacheFile =
      cacheDir ? join(cacheDir, `base-${baseSha}-${configHash}.json`) : null;

    if (cacheFile && existsSync(cacheFile)) {
      base = JSON.parse(readFileSync(cacheFile, "utf8"));
      console.log(
        `[true-site-size] base (${compareRef} @ ${baseSha.slice(0, 9)}) loaded from cache - skipping its build and measurement`,
      );
      logBreakdown("base (cached)", base);
    } else {
      console.log(`[true-site-size] measuring base (${compareRef})...`);
      const baseDir = join(workspace, ".true-site-size-base");
      rmSync(baseDir, { recursive: true, force: true });
      run(`git worktree add --detach ${baseDir} FETCH_HEAD`, workspace);
      try {
        base = await buildAndMeasure(baseDir, config);
        logBreakdown("base", base);
        // only cache fully-successful measurements: an error row (eg a
        // missing mark, or a flaky run) must not persist for this sha
        if (cacheFile && base.every((r) => !r.error)) {
          mkdirSync(cacheDir, { recursive: true });
          writeFileSync(cacheFile, JSON.stringify(base));
          console.log("[true-site-size] base result cached for future runs");
        }
      } catch (e) {
        console.warn(
          `[true-site-size] base measurement failed (reporting head only): ${e.message}`,
        );
      } finally {
        run(`git worktree remove --force ${baseDir}`, workspace);
      }
    }
  }

  const runUrl =
    process.env.GITHUB_RUN_ID ?
      `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : undefined;
  const body = formatComment(head, base, {
    baseLabel,
    runUrl,
    commentKey: config.commentKey,
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
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
