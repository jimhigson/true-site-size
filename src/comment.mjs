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
  { baseLabel, runUrl, commentKey },
) => {
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

  const spreadNote = head.some((h) => h.bytesSpread > 0)
    ? `\n> ⚠️ **determinism check failed**: repeat runs transferred different bytes (max spread ${formatBytes(Math.max(...head.map((h) => h.bytesSpread ?? 0)))}). Something loads non-deterministically - do not trust deltas until investigated. The per-request breakdown in the run logs shows which requests varied.`
    : "";

  return `${markerFor(commentKey)}
### 📡 real network cost to ready${commentKey ? ` (${commentKey})` : ""}

True wire bytes from cold cache until each scenario's \`performance.mark\`, network settled. Compared against ${baseLabel}.

| scenario | this PR | base | change |
| --- | --- | --- | --- |
${rows.join("\n")}
${totalRow}
${spreadNote}
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
