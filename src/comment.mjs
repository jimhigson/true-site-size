import { formatBytes, formatDuration } from "./formatBytes.mjs";

/**
 * each comment-key maintains its own comment on the pr, so one workflow can
 * report several measurements (eg a game and an editor build)
 */
const markerFor = (commentKey) =>
  `<!-- true-site-size${commentKey ? `:${commentKey}` : ""} -->`;

const formatDelta = (head, base) => {
  if (head == null || base == null) return "—";
  const d = head - base;
  const pct = base === 0 ? 0 : (d / base) * 100;
  const arrow =
    d > 0 ? "🔺"
    : d < 0 ? "🟢"
    : "✅";
  const sign = d > 0 ? "+" : "";
  return `${arrow} ${sign}${formatBytes(Math.abs(d))}${d < 0 ? " saved" : ""} (${sign}${pct.toFixed(1)}%)`;
};

/** build the markdown body for the PR comment */
export const formatComment = (
  /** per-scenario head results */
  head,
  /** per-scenario base results, or null when no base was measurable */
  base,
  /** { baseLabel } */
  { baseLabel, runUrl, commentKey, stripHash, spreadToleranceBytes = 0 },
) => {
  const stripRe = stripHash ? new RegExp(stripHash, "g") : null;
  /** filename for matching across refs: pathname with the content hash removed */
  const fileOf = (url) => {
    const path = url.startsWith("blob:") ? "(blob)" : new URL(url).pathname;
    return stripRe ? path.replace(stripRe, ".") : path;
  };
  /** sum request bytes per hash-stripped file, skipping ignored requests */
  const filesOf = (requestLog) => {
    const m = new Map();
    for (const { url, bytes, ignored } of requestLog ?? []) {
      if (ignored) continue;
      const f = fileOf(url);
      m.set(f, (m.get(f) ?? 0) + bytes);
    }
    return m;
  };

  /** collapsed per-file breakdown vs base, compressed-size-action style */
  const detailsFor = (h, b) => {
    if (h.error || !b || b.error) return "";
    const headFiles = filesOf(h.requestLog);
    const baseFiles = filesOf(b.requestLog);
    const all = [...new Set([...headFiles.keys(), ...baseFiles.keys()])];
    const changed = all
      .map((f) => {
        const hb = headFiles.get(f);
        const bb = baseFiles.get(f);
        return { f, hb, bb, delta: (hb ?? 0) - (bb ?? 0) };
      })
      .filter(({ delta }) => delta !== 0)
      .sort((a, z) => Math.abs(z.delta) - Math.abs(a.delta));
    const unchangedCount = all.length - changed.length;
    if (changed.length === 0) {
      return `\n<details><summary>${h.name}: no per-file changes (${unchangedCount} files identical)</summary></details>`;
    }
    const fileRows = changed.map(({ f, hb, bb }) => {
      const deltaCell =
        bb === undefined ? `🔺 +${formatBytes(hb)} (new)`
        : hb === undefined ? `🟢 ${formatBytes(bb)} saved (no longer loaded)`
        : formatDelta(hb, bb);
      const note =
        bb === undefined ? " 🆕"
        : hb === undefined ? " 🗑️"
        : "";
      return `| \`${f}\`${note} | ${formatBytes(hb)} | ${formatBytes(bb)} | ${deltaCell} |`;
    });
    return `\n<details><summary>${h.name}: ${changed.length} file(s) changed, ${unchangedCount} identical</summary>\n\n| file | this PR | base | change |\n| --- | --- | --- | --- |\n${fileRows.join("\n")}\n</details>`;
  };
  const rows = head.map((h) => {
    const b = base?.find((r) => r.name === h.name);
    if (h.error) {
      return `| ${h.name} | ⚠️ unable to measure - ${h.error} | | |`;
    }
    const baseCell =
      b == null ? "—"
      : b.error ? `⚠️ unable to measure - ${b.error}`
      : formatBytes(b.bytes);
    const deltaCell = formatDelta(h.bytes, b?.error ? null : b?.bytes);
    const ignoredNote =
      h.ignoredBytes > 0 ? `, ${formatBytes(h.ignoredBytes)} ignored` : "";
    return `| ${h.name} | ${formatBytes(h.bytes)} (${h.requests} reqs, ${formatDuration(h.timeToMarkMs)} to mark${ignoredNote}) | ${baseCell} | ${deltaCell} |`;
  });

  const totalHead = head.every((h) => !h.error)
    ? head.reduce((a, h) => a + h.bytes, 0)
    : null;
  const totalBase =
    base && base.every((b) => !b.error)
      ? base.reduce((a, b) => a + b.bytes, 0)
      : null;
  const totalRow =
    totalHead != null
      ? `| **journey total** | **${formatBytes(totalHead)}** | ${totalBase != null ? `**${formatBytes(totalBase)}**` : "—"} | ${formatDelta(totalHead, totalBase)} |`
      : "";

  // a url transferred in full more than once in a single row is a standing
  // bug in the measured app (eg the same asset fetched with mismatched
  // crossorigin modes, defeating request coalescing)
  const duplicateNotes = head
    .filter((h) => !h.error)
    .flatMap((h) => {
      const transfers = new Map();
      for (const { url, bytes, ignored } of h.requestLog ?? []) {
        if (ignored || bytes === 0) continue;
        transfers.set(url, [...(transfers.get(url) ?? []), bytes]);
      }
      return [...transfers]
        .filter(([, sizes]) => sizes.length > 1)
        .map(([url, sizes]) => {
          // everything beyond one copy is waste
          const wasted = sizes.reduce((a, b) => a + b, 0) - Math.max(...sizes);
          return `\n> 🔁 **${h.name}** downloads \`${new URL(url).pathname}\` ${sizes.length} times in full (~${formatBytes(wasted)} wasted) - likely uncoalesced duplicate requests (eg crossorigin mismatch)`;
        });
    })
    .join("");

  const maxSpread = Math.max(...head.map((h) => h.bytesSpread ?? 0), 0);
  const spreadNote =
    maxSpread > spreadToleranceBytes ?
      `\n> ⚠️ **determinism check failed**: repeat runs transferred different bytes (max spread ${formatBytes(maxSpread)}, tolerance ${formatBytes(spreadToleranceBytes)}). Something loads non-deterministically - do not trust deltas until investigated. The per-request breakdown in the run logs shows which requests varied.`
    : maxSpread > 0 ?
      `\n<sub>runs varied by up to ${formatBytes(maxSpread)} (h2 header-compression noise, within the ${formatBytes(spreadToleranceBytes)} tolerance) - the minimum is reported</sub>`
    : "";

  return `${markerFor(commentKey)}
### 📡 real network cost to ready${commentKey ? ` (${commentKey})` : ""}

True wire bytes from cold cache until each scenario's \`performance.mark\`, network settled. Compared against ${baseLabel}.

| scenario | this PR | base | change |
| --- | --- | --- | --- |
${rows.join("\n")}
${totalRow}
${spreadNote}${duplicateNotes}
${head.map((h) => detailsFor(h, base?.find((r) => r.name === h.name))).join("")}
${runUrl ? `\n<sub>📋 per-request breakdown (every url, size and timing) is in the [run logs](${runUrl})</sub>` : ""}
<sub>measured by [true-site-size](https://github.com/jimhigson/true-site-size)</sub>
`;
};

/** create or update the marker-identified comment on the PR */
export const postComment = async (
  body,
  { token, repo, issueNumber, commentKey, apiUrl = "https://api.github.com" },
) => {
  const marker = markerFor(commentKey);
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "content-type": "application/json",
  };
  const listRes = await fetch(
    `${apiUrl}/repos/${repo}/issues/${issueNumber}/comments?per_page=100`,
    { headers },
  );
  if (!listRes.ok) {
    throw new Error(`listing comments failed: ${listRes.status} ${await listRes.text()}`);
  }
  const existing = (await listRes.json()).find((c) => c.body?.includes(marker));
  const target =
    existing ?
      { url: `${apiUrl}/repos/${repo}/issues/comments/${existing.id}`, method: "PATCH" }
    : {
        url: `${apiUrl}/repos/${repo}/issues/${issueNumber}/comments`,
        method: "POST",
      };
  const res = await fetch(target.url, {
    method: target.method,
    headers,
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    throw new Error(`posting comment failed: ${res.status} ${await res.text()}`);
  }
};
