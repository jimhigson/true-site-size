const marker = "<!-- real-site-size -->";

const formatBytes = (n) => {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
};

const formatDelta = (head, base) => {
  if (head == null || base == null) return "—";
  const d = head - base;
  const pct = base === 0 ? 0 : (d / base) * 100;
  const arrow =
    d > 0 ? "🔺"
    : d < 0 ? "🟢"
    : "✅";
  const sign = d > 0 ? "+" : "";
  return `${arrow} ${sign}${formatBytes(Math.abs(d) * Math.sign(d) || 0).replace("-", "")}${d < 0 ? " saved" : ""} (${sign}${pct.toFixed(1)}%)`;
};

/** build the markdown body for the PR comment */
export const formatComment = (
  /** per-scenario head results */
  head,
  /** per-scenario base results, or null when no base was measurable */
  base,
  /** { baseLabel } */
  { baseLabel },
) => {
  const rows = head.map((h) => {
    const b = base?.find((r) => r.name === h.name);
    if (h.error) {
      return `| ${h.name} | ⚠️ ${h.error} | | |`;
    }
    const baseCell =
      b == null ? "—"
      : b.error ? `⚠️ no data`
      : formatBytes(b.bytes);
    const deltaCell = formatDelta(h.bytes, b?.error ? null : b?.bytes);
    return `| ${h.name} | ${formatBytes(h.bytes)} (${h.requests} reqs, ${h.timeToMarkMs}ms to mark) | ${baseCell} | ${deltaCell} |`;
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
    ? `\n> ⚠️ byte counts varied between runs (max spread ${formatBytes(Math.max(...head.map((h) => h.bytesSpread ?? 0)))}) - treat small deltas with caution`
    : "";

  return `${marker}
### 📡 real network cost to ready

Minimum wire bytes from cold cache until each scenario's \`performance.mark\`, network settled. Compared against ${baseLabel}.

| scenario | this PR | base | change |
| --- | --- | --- | --- |
${rows.join("\n")}
${totalRow}
${spreadNote}
`;
};

/** create or update the marker-identified comment on the PR */
export const postComment = async (
  body,
  { token, repo, issueNumber, apiUrl = "https://api.github.com" },
) => {
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
