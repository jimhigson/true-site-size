import CDP from "chrome-remote-interface";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const chromeCandidates = [
  process.env.CHROME_PATH,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].filter(Boolean);

export const findChrome = () => {
  const found = chromeCandidates.find((c) => existsSync(c));
  if (!found) {
    throw new Error(
      `no Chrome found - set CHROME_PATH. Tried: ${chromeCandidates.join(", ")}`,
    );
  }
  return found;
};

const launchChrome = async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "true-site-size-"));
  const child = spawn(
    findChrome(),
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--metrics-recording-only",
      "--mute-audio",
      // ci runners have a small /dev/shm which can crash renderers
      "--disable-dev-shm-usage",
      // external hosts resolve to nothing: measurements stay deterministic
      // and only the local server contributes bytes
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const port = await new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(
      () => reject(new Error(`chrome did not start: ${stderr}`)),
      60_000,
    );
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      const m = stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.on("exit", () => reject(new Error(`chrome exited early: ${stderr}`)));
  });
  return {
    port,
    close: async () => {
      const exited = new Promise((r) => child.once("exit", r));
      child.kill();
      await exited;
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5 });
    },
  };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run all scenarios once, in order, in a single browser session (so the http
 * cache carries between scenarios and each reports only its incremental
 * bytes). Returns per-scenario results.
 */
export const runScenarios = async (
  /** array of { name, url, mark } */
  scenarios,
  /** { settleMs, markTimeoutMs } */
  { settleMs, markTimeoutMs },
) => {
  const chrome = await launchChrome();
  const client = await CDP({ port: chrome.port });
  const { Network, Page, Runtime } = client;
  const results = [];

  try {
    await Network.enable({});
    await Network.setBypassServiceWorker({ bypass: true });
    await Page.enable();
    // bypassing only stops an active worker serving requests - registration
    // would still install one whose background precache warms the http cache
    // and silently absorbs page bytes. Disable registration outright so the
    // measurement sees what a fresh visitor's page actually transfers
    await Page.addScriptToEvaluateOnNewDocument({
      source: `if (navigator.serviceWorker) {
        navigator.serviceWorker.register = () =>
          Promise.reject(new Error("service workers disabled by true-site-size"));
      }`,
    });
    await Runtime.enable();

    // network accounting - reset per scenario
    let bytes = 0;
    let requests = 0;
    let failed = 0;
    let lastActivity = Date.now();
    const inflight = new Set();
    /** per-request {url, bytes, atMs} for the current scenario */
    let requestLog = [];
    let scenarioStart = Date.now();
    const urlOf = new Map();

    Network.requestWillBeSent(({ requestId, request }) => {
      if (request.url.startsWith("data:")) return;
      inflight.add(requestId);
      urlOf.set(requestId, request.url);
      lastActivity = Date.now();
    });
    Network.loadingFinished(({ requestId, encodedDataLength }) => {
      if (!inflight.has(requestId)) return;
      inflight.delete(requestId);
      bytes += encodedDataLength;
      requests += 1;
      requestLog.push({
        url: urlOf.get(requestId),
        bytes: encodedDataLength,
        atMs: Date.now() - scenarioStart,
      });
      lastActivity = Date.now();
    });
    Network.loadingFailed(({ requestId }) => {
      if (!inflight.has(requestId)) return;
      inflight.delete(requestId);
      failed += 1;
      lastActivity = Date.now();
    });
    Network.requestServedFromCache(() => {
      lastActivity = Date.now();
    });

    for (const scenario of scenarios) {
      bytes = 0;
      requests = 0;
      failed = 0;
      inflight.clear();
      requestLog = [];
      scenarioStart = Date.now();

      const navStart = Date.now();
      await Page.navigate({ url: scenario.url });

      // wait for the app's performance mark
      let markTime;
      for (;;) {
        const { result } = await Runtime.evaluate({
          expression: `performance.getEntriesByName(${JSON.stringify(scenario.mark)}, "mark")[0]?.startTime ?? null`,
          returnByValue: true,
        });
        if (result.value !== null && result.value !== undefined) {
          markTime = result.value;
          break;
        }
        if (Date.now() - navStart > markTimeoutMs) {
          markTime = null;
          break;
        }
        await sleep(50);
      }

      if (markTime === null) {
        results.push({
          name: scenario.name,
          error: `mark "${scenario.mark}" not seen within ${markTimeoutMs}ms`,
        });
        continue;
      }

      // settle: wait until nothing is in flight and the network has been
      // quiet for settleMs
      for (;;) {
        if (inflight.size === 0 && Date.now() - lastActivity >= settleMs) {
          break;
        }
        await sleep(50);
      }

      results.push({
        name: scenario.name,
        bytes,
        requests,
        failedRequests: failed,
        timeToMarkMs: Math.round(markTime),
        requestLog: [...requestLog],
      });
    }
  } finally {
    await client.close().catch(() => {});
    await chrome.close();
  }
  return results;
};

/**
 * Run the full scenario sequence `runs` times in fresh browser profiles and
 * report, per scenario, the minimum bytes across runs (the deterministic
 * critical-path payload) plus the spread for flagging instability.
 */
export const measure = async (scenarios, { runs, settleMs, markTimeoutMs }) => {
  const allRuns = [];
  for (let i = 0; i < runs; i++) {
    allRuns.push(await runScenarios(scenarios, { settleMs, markTimeoutMs }));
  }
  return scenarios.map((scenario, i) => {
    const runsFor = allRuns.map((run) => run[i]);
    const errored = runsFor.find((r) => r.error);
    const ok = runsFor.filter((r) => !r.error);
    if (ok.length === 0) {
      return { name: scenario.name, error: errored.error };
    }
    const bytesValues = ok.map((r) => r.bytes);
    const min = Math.min(...bytesValues);
    const max = Math.max(...bytesValues);
    const best = ok.find((r) => r.bytes === min);
    return {
      name: scenario.name,
      bytes: min,
      bytesSpread: max - min,
      requests: best.requests,
      failedRequests: best.failedRequests,
      timeToMarkMs: best.timeToMarkMs,
      requestLog: best.requestLog,
    };
  });
};
