import CDP from "chrome-remote-interface";
import { spawn } from "node:child_process";

import { formatDuration } from "./formatBytes.mjs";
import { certSpkiHash } from "./serve.mjs";
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
      // trust (not merely ignore) the measurement server's self-signed cert:
      // spki pinning keeps chrome's http cache enabled, where a blanket
      // ignore-certificate-errors would disable caching for the origin and
      // fake duplicate-download bugs
      `--ignore-certificate-errors-spki-list=${certSpkiHash}`,
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

/** named keys for the `keys` step; single characters pass through */
const keyDefs = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: {
    key: "ArrowRight",
    code: "ArrowRight",
    windowsVirtualKeyCode: 39,
  },
};

/**
 * Run a journey once in a fresh browser. A journey is an array of steps:
 *
 *  - { goto: url } - navigate
 *  - { click: selector } - wait for the selector to exist and be visible,
 *    scroll it into view, then send a trusted click to its centre
 *  - { keys: "Enter ArrowDown a" } - trusted key presses, space-separated
 *  - { script: "..." } - evaluate in the page (awaited if it returns a promise)
 *  - { row: name, mark: markName } - wait for the performance mark then for
 *    the network to settle; closes the current measurement segment as a
 *    result row
 *
 * Any step may also carry afterMark: markName to wait for an app readiness
 * mark before the step runs.
 *
 * Requests whose urls match ignorePatterns are logged but not counted - for
 * endpoints whose response size legitimately varies (eg live db reads).
 */
export const runJourney = async (
  steps,
  { settleMs, markTimeoutMs, stepTimeoutMs, settleTimeoutMs, ignorePatterns },
) => {
  const chrome = await launchChrome();
  const client = await CDP({ port: chrome.port });
  const { Network, Page, Runtime, Input, Target } = client;
  const results = [];
  const ignoreRes = (ignorePatterns ?? []).map((p) => new RegExp(p));

  try {
    await Network.enable({});
    await Network.setBypassServiceWorker({ bypass: true });
    await Page.enable();
    await Runtime.enable();
    // workers are separate cdp targets: without attaching, a worker script's
    // loadingFinished never reaches the page session (the request looks
    // in-flight forever) and bytes the worker fetches go uncounted. Attach
    // flat so worker-session Network events flow through the same connection
    // waitForDebuggerOnStart pauses each worker until Network is enabled on
    // its session, so the worker's own script fetch and sub-fetches are
    // captured rather than lost in the attach race
    await Target.setAutoAttach({
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
    client.on("Target.attachedToTarget", async ({ sessionId, targetInfo }) => {
      // the page session reports a requestWillBeSent for the worker script
      // but never a completion (that belongs to the worker session) - drop
      // the phantom so it cannot block settling; the worker session counts
      // the script's bytes itself
      for (const [key, entry] of inflight) {
        if (entry.url === targetInfo.url) {
          inflight.delete(key);
        }
      }
      try {
        await client.send("Network.enable", {}, sessionId);
      } catch {
        // target may already be gone
      }
      client
        .send("Runtime.runIfWaitingForDebugger", {}, sessionId)
        .catch(() => {});
    });
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

    // network accounting for the current row segment
    let bytes = 0;
    let requests = 0;
    let failed = 0;
    let ignoredBytes = 0;
    let lastActivity = Date.now();
    let segmentStart = Date.now();
    let requestLog = [];
    /** key -> { url, responded, dataBytes } */
    const inflight = new Map();

    const isIgnored = (url) => ignoreRes.some((re) => re.test(url));

    // network events arrive from the page session and any attached worker
    // sessions; requestIds are only unique per session, so key on both
    const keyOf = (sessionId, requestId) => `${sessionId ?? "page"}:${requestId}`;

    const countAs = (url, byteCount, note) => {
      const ignored = isIgnored(url);
      if (ignored) {
        ignoredBytes += byteCount;
      } else {
        bytes += byteCount;
        requests += 1;
      }
      requestLog.push({
        url,
        bytes: byteCount,
        atMs: Date.now() - segmentStart,
        ...(ignored && { ignored: true }),
        ...(note && { note }),
      });
    };

    const onRequestWillBeSent = ({ requestId, request }, sessionId) => {
      if (request.url.startsWith("data:")) return;
      const key = keyOf(sessionId, requestId);
      inflight.set(key, {
        url: request.url,
        responded: false,
        dataBytes: 0,
      });
      lastActivity = Date.now();
    };
    const onLoadingFinished = ({ requestId, encodedDataLength }, sessionId) => {
      const key = keyOf(sessionId, requestId);
      const entry = inflight.get(key);
      if (!entry) return;
      inflight.delete(key);
      countAs(entry.url, encodedDataLength);
      lastActivity = Date.now();
    };
    const onLoadingFailed = ({ requestId }, sessionId) => {
      const key = keyOf(sessionId, requestId);
      if (!inflight.has(key)) return;
      inflight.delete(key);
      failed += 1;
      lastActivity = Date.now();
    };

    client.on("event", ({ method, params, sessionId }) => {
      if (method === "Network.requestWillBeSent") {
        onRequestWillBeSent(params, sessionId);
      } else if (method === "Network.loadingFinished") {
        onLoadingFinished(params, sessionId);
      } else if (method === "Network.loadingFailed") {
        onLoadingFailed(params, sessionId);
      } else if (method === "Network.responseReceived") {
        const entry = inflight.get(keyOf(sessionId, params.requestId));
        if (entry) {
          entry.responded = true;
          entry.dataBytes += params.response?.encodedDataLength ?? 0;
        }
        lastActivity = Date.now();
      } else if (method === "Network.dataReceived") {
        const entry = inflight.get(keyOf(sessionId, params.requestId));
        if (entry) {
          entry.dataBytes += params.encodedDataLength ?? 0;
        }
        lastActivity = Date.now();
      } else if (method === "Network.requestServedFromCache") {
        lastActivity = Date.now();
      }
    });

    /**
     * a request that has received its full response but never emits
     * loadingFinished - eg a dedicated worker's script, whose completion
     * event is lost between cdp targets - would otherwise block settling
     * forever. Once such requests have been quiet for the settle window,
     * count them using the bytes observed via dataReceived
     */
    const drainZombies = () => {
      for (const [key, entry] of inflight) {
        if (entry.responded) {
          inflight.delete(key);
          countAs(entry.url, entry.dataBytes, "no loadingFinished event");
        }
      }
    };

    const resetSegment = () => {
      bytes = 0;
      requests = 0;
      failed = 0;
      ignoredBytes = 0;
      requestLog = [];
      inflight.clear();
      segmentStart = Date.now();
    };

    const waitForMark = async (mark, timeoutMs) => {
      const start = Date.now();
      for (;;) {
        const { result } = await Runtime.evaluate({
          expression: `performance.getEntriesByName(${JSON.stringify(mark)}, "mark")[0]?.startTime ?? null`,
          returnByValue: true,
        });
        if (result.value !== null && result.value !== undefined) {
          return result.value;
        }
        if (Date.now() - start > timeoutMs) {
          return null;
        }
        await sleep(50);
      }
    };

    const waitForSettle = async () => {
      const start = Date.now();
      for (;;) {
        const quiet = Date.now() - lastActivity >= settleMs;
        if (inflight.size === 0 && quiet) {
          return;
        }
        // only zombie requests left (responded, no completion event) and the
        // network has been quiet: account for them and finish
        if (
          quiet &&
          [...inflight.values()].every((entry) => entry.responded)
        ) {
          drainZombies();
          if (inflight.size === 0) return;
        }
        if (Date.now() - start > settleTimeoutMs) {
          // diagnose rather than hang: name what is keeping the network busy
          const stuck = [...inflight.values()].map((entry) => entry.url);
          const recent = requestLog
            .slice(-5)
            .map(({ url, atMs }) => `${url} (at ${atMs}ms)`);
          throw new Error(
            `network never settled within ${formatDuration(settleTimeoutMs)}. ` +
              (stuck.length ? `in-flight: ${stuck.join(", ")}. ` : "") +
              (recent.length ? `most recent requests: ${recent.join(", ")}` : ""),
          );
        }
        await sleep(50);
      }
    };

    /** wait for selector to exist + be visible; returns its centre point */
    const waitForClickable = async (selector) => {
      const start = Date.now();
      for (;;) {
        const { result } = await Runtime.evaluate({
          expression: `(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return null;
            el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
            // display:contents elements have no box of their own - fall back
            // to the first descendant that does
            const boxOf = (node) => {
              const r = node.getBoundingClientRect();
              if (r.width > 0 && r.height > 0) return r;
              for (const child of node.querySelectorAll("*")) {
                const cr = child.getBoundingClientRect();
                if (cr.width > 0 && cr.height > 0) return cr;
              }
              return null;
            };
            const r = boxOf(el);
            if (!r) return null;
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          })()`,
          returnByValue: true,
        });
        if (result.value) return result.value;
        if (Date.now() - start > stepTimeoutMs) {
          throw new Error(
            `click target not found/visible within ${formatDuration(stepTimeoutMs)}: ${selector}`,
          );
        }
        await sleep(50);
      }
    };

    let stepError = null;
    for (const step of steps) {
      try {
        if (step.afterMark) {
          const seen = await waitForMark(step.afterMark, markTimeoutMs);
          if (seen === null) {
            throw new Error(`afterMark "${step.afterMark}" not seen`);
          }
        }

        if (step.goto !== undefined) {
          await Page.navigate({ url: step.goto });
        } else if (step.waitFor !== undefined || step.waitForGone !== undefined) {
          // wait until a css selector becomes present (waitFor) or absent
          // (waitForGone, eg a loading dialog has cleared) before acting
          const selector = step.waitFor ?? step.waitForGone;
          const wantPresent = step.waitFor !== undefined;
          const start = Date.now();
          for (;;) {
            const { result } = await Runtime.evaluate({
              expression: `document.querySelector(${JSON.stringify(selector)}) !== null`,
              returnByValue: true,
            });
            if (result.value === wantPresent) break;
            if (Date.now() - start > stepTimeoutMs) {
              throw new Error(
                `${wantPresent ? "waitFor" : "waitForGone"} "${selector}" ${wantPresent ? "not present" : "still present"} within ${formatDuration(stepTimeoutMs)}`,
              );
            }
            await sleep(50);
          }
        } else if (step.click !== undefined) {
          const { x, y } = await waitForClickable(step.click);
          for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
            await Input.dispatchMouseEvent({
              type,
              x,
              y,
              button: type === "mouseMoved" ? "none" : "left",
              clickCount: 1,
            });
          }
        } else if (step.keys !== undefined) {
          for (const name of step.keys.split(/\s+/).filter(Boolean)) {
            const def =
              keyDefs[name] ??
              (name.length === 1 ?
                { key: name, code: `Key${name.toUpperCase()}`, text: name }
              : null);
            if (!def) throw new Error(`unknown key: ${name}`);
            await Input.dispatchKeyEvent({ type: "keyDown", ...def });
            // hold before releasing: input loops that sample the keyboard once
            // per animation frame (eg a game reading key state per tick) never
            // see a press that goes down and up within a single frame
            await sleep(100);
            await Input.dispatchKeyEvent({ type: "keyUp", ...def });
            await sleep(80);
          }
        } else if (step.script !== undefined) {
          const { exceptionDetails } = await Runtime.evaluate({
            expression: step.script,
            awaitPromise: true,
          });
          if (exceptionDetails) {
            // .text is just "Uncaught"; the real message/stack is on .exception
            throw new Error(
              `script step threw: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`,
            );
          }
        } else if (step.row !== undefined) {
          // a row may wait on one mark or several (all must fire) - for apps
          // whose "ready" is the conjunction of independently-loading parts
          const marks = step.marks ?? [step.mark];
          const deadline = Date.now() + markTimeoutMs;
          for (const mark of marks) {
            const markTime = await waitForMark(
              mark,
              Math.max(0, deadline - Date.now()),
            );
            if (markTime === null) {
              throw new Error(
                `mark "${mark}" not seen within ${formatDuration(markTimeoutMs)}`,
              );
            }
          }
          await waitForSettle();
          results.push({
            name: step.row,
            bytes,
            requests,
            failedRequests: failed,
            ignoredBytes,
            timeToMarkMs: Math.round(Date.now() - segmentStart),
            requestLog: [...requestLog],
          });
          resetSegment();
        } else {
          throw new Error(`unrecognised step: ${JSON.stringify(step)}`);
        }
      } catch (e) {
        stepError = e.message;
        break;
      }
    }
    if (stepError !== null) {
      // attribute the failure to the row the journey was working towards
      const remaining = steps.filter(
        (s, i) => s.row !== undefined && i >= 0,
      );
      const nextRowName =
        remaining[results.length]?.row ?? `row ${results.length + 1}`;
      results.push({ name: nextRowName, error: stepError });
    }
  } finally {
    await client.close().catch(() => {});
    await chrome.close();
  }
  return results;
};

/**
 * Run the journey `runs` times in fresh browser profiles. Runs are expected
 * to transfer identical bytes - the repeat is a determinism self-check. The
 * reported figures (and the request log) come from the cheapest run; any
 * disagreement is surfaced as bytesSpread.
 */
export const measure = async (
  steps,
  { runs, settleMs, markTimeoutMs, stepTimeoutMs, settleTimeoutMs, ignorePatterns },
) => {
  const allRuns = [];
  for (let i = 0; i < runs; i++) {
    allRuns.push(
      await runJourney(steps, {
        settleMs,
        markTimeoutMs,
        stepTimeoutMs,
        settleTimeoutMs,
        ignorePatterns,
      }),
    );
  }
  const rowCount = Math.max(...allRuns.map((r) => r.length));
  return Array.from({ length: rowCount }, (_, i) => {
    const runsFor = allRuns.map((run) => run[i]).filter(Boolean);
    const errored = runsFor.find((r) => r?.error);
    const ok = runsFor.filter((r) => r && !r.error);
    if (ok.length === 0) {
      return { name: errored?.name ?? `row ${i + 1}`, error: errored?.error };
    }
    const bytesValues = ok.map((r) => r.bytes);
    const min = Math.min(...bytesValues);
    const max = Math.max(...bytesValues);
    const best = ok.find((r) => r.bytes === min);
    return {
      ...best,
      bytesSpread: max - min,
      ...(errored && {
        error: `succeeded in only ${ok.length}/${runsFor.length} runs: ${errored.error}`,
      }),
    };
  });
};
