import { formatBytes } from "./formatBytes.mjs";

/**
 * each comment-key maintains its own comment on the pr, so one workflow can
 * report several measurements (eg a game and an editor build)
 */
const markerFor = (commentKey) =>
  `<!-- true-site-size${commentKey ? `:${commentKey}` : ""} -->`;

const formatDelta = (
  head,
  base,
  /** changes smaller than this many bytes display as no-change */
  minimumChangeThreshold,
) => {
  if (head == null || base == null) return "—";
  const d = head - base;
  if (d === 0 || Math.abs(d) < minimumChangeThreshold) return "🟰";
  const pct = base === 0 ? 0 : Math.abs((d / base) * 100);
  const arrow = d > 0 ? "📈" : "📉";
  const sign = d > 0 ? "+" : "-";
  return `${arrow} ${sign}${formatBytes(Math.abs(d))} (${sign}${pct.toFixed(1)}%)`;
};

/**
 * column header for one base ref: the ref linked to the exact commit measured,
 * annotated with `git describe` when it names something other than the ref
 * itself (eg a branch shown as the release it descends from)
 */
const baseHeader = (b) => {
  const name = b.url ? `[${b.ref}](${b.url})` : `\`${b.ref}\``;
  const desc = b.describe && b.describe !== b.ref ? ` · ${b.describe}` : "";
  return `vs ${name}${desc}`;
};

/** build the markdown body for the PR comment */
export const formatComment = (
  /** per-scenario head results */
  head,
  /** array of base refs: { ref, sha, describe, url, results, error } */
  bases,
  {
    runUrl,
    commentKey,
    stripHash,
    spreadToleranceBytes = 0,
    minimumChangeThreshold = 1,
    collapsibleBreakdown = true,
  },
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

  /** the base's row matching a head row by name (undefined if absent) */
  const baseRowFor = (b, name) => b.results?.find((r) => r.name === name);

  /** compact delta for the summary table: arrow + signed bytes, no percentage */
  const deltaShort = (h, base) => {
    const d = h - base;
    if (d === 0 || Math.abs(d) < minimumChangeThreshold) return "🟰";
    return `${d > 0 ? "📈 +" : "📉 -"}${formatBytes(Math.abs(d))}`;
  };

  /** per-file diff of a head row vs a base ref: { changed, unchangedCount },
   *  or null when the row or base could not be measured */
  const fileDiff = (h, b) => {
    const br = baseRowFor(b, h.name);
    if (h.error || !br || br.error) return null;
    const headFiles = filesOf(h.requestLog);
    const baseFiles = filesOf(br.requestLog);
    const all = [...new Set([...headFiles.keys(), ...baseFiles.keys()])];
    const changed = all
      .map((f) => {
        const hb = headFiles.get(f);
        const bb = baseFiles.get(f);
        return { f, hb, bb, delta: (hb ?? 0) - (bb ?? 0) };
      })
      .filter(
        ({ delta }) => delta !== 0 && Math.abs(delta) >= minimumChangeThreshold,
      )
      .sort((a, z) => Math.abs(z.delta) - Math.abs(a.delta));
    return { changed, unchangedCount: all.length - changed.length };
  };

  /** the markdown table of a row's changed files vs a base ref */
  const fileTable = (b, changed) => {
    const fileRows = changed.map(({ f, hb, bb }) => {
      const deltaCell =
        bb === undefined ? `📈 +${formatBytes(hb)}`
        : hb === undefined ? `📉 -${formatBytes(bb)}`
        : formatDelta(hb, bb, minimumChangeThreshold);
      const note =
        bb === undefined ? " 🆕"
        : hb === undefined ? " 🗑️"
        : "";
      return `| \`${f}\`${note} | ${formatBytes(hb)} | ${formatBytes(bb)} | ${deltaCell} |`;
    });
    return `| file | PR | ${b.ref} | delta |\n| --- | --- | --- | --- |\n${fileRows.join("\n")}`;
  };

  /**
   * per-base-ref breakdown: a heading, then one entry per row. A row with no
   * changes is a plain line (nothing to reveal by expanding); a changed row is
   * a collapsible <details> by default, or shown inline when
   * collapsibleBreakdown is false. Empty when the base could not be measured.
   */
  const breakdownFor = (b) => {
    if (!b.results) return "";
    const entries = head
      .map((h) => {
        const diff = fileDiff(h, b);
        if (!diff) return null;
        if (diff.changed.length === 0) {
          return `**${h.name}**: no per-file changes (${diff.unchangedCount} files identical)`;
        }
        const summary = `**${h.name}**: ${diff.changed.length} file(s) changed, ${diff.unchangedCount} identical`;
        const table = fileTable(b, diff.changed);
        return collapsibleBreakdown ?
            `<details><summary>${summary}</summary>\n\n${table}\n</details>`
          : `${summary}\n\n${table}`;
      })
      .filter(Boolean);
    return entries.length ?
        `\n#### ${baseHeader(b)}\n\n${entries.join("\n\n")}\n`
      : "";
  };

  // table: row label, the PR value, then one delta column per base ref. Each
  // base cell shows the delta with that base's own value in parentheses.
  const headerCells = ["", "PR", ...bases.map(baseHeader)];
  const sepCells = headerCells.map(() => "---");

  const rows = head.map((h) => {
    const prCell =
      h.error ? `⚠️ unable to measure - ${h.error}` : formatBytes(h.bytes);
    const baseCells = bases.map((b) => {
      if (h.error) return "—";
      const br = baseRowFor(b, h.name);
      if (!br || br.error) return "—";
      return `${deltaShort(h.bytes, br.bytes)} → ${formatBytes(br.bytes)}`;
    });
    return `| ${[h.name, prCell, ...baseCells].join(" | ")} |`;
  });

  const totalHead =
    head.every((h) => !h.error) ?
      head.reduce((a, h) => a + h.bytes, 0)
    : null;
  const totalRow =
    totalHead != null ?
      `| ${[
        "**total**",
        `**${formatBytes(totalHead)}**`,
        ...bases.map((b) => {
          const ok = b.results && b.results.every((r) => !r.error);
          if (!ok) return "—";
          const totalBase = b.results.reduce((a, r) => a + r.bytes, 0);
          return `${deltaShort(totalHead, totalBase)} → ${formatBytes(totalBase)}`;
        }),
      ].join(" | ")} |`
    : "";

  const totalIgnored = head.reduce((a, h) => a + (h.ignoredBytes ?? 0), 0);
  const ignoredNote =
    totalIgnored > 0 ?
      `\n<sub>${formatBytes(totalIgnored)} matched ignore-url-patterns and is not counted</sub>`
    : "";

  // bases that could not be measured: noted once rather than in every cell
  const baseErrorNotes = bases
    .filter((b) => !b.results)
    .map(
      (b) =>
        `\n> ⚠️ base \`${b.ref}\` could not be measured${b.error ? ` - ${b.error}` : ""}`,
    )
    .join("");

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

  const comparedNote =
    bases.length === 0 ?
      "\n<sub>no base ref to compare against - showing head only</sub>"
    : "";

  // per-file breakdown grouped under a heading per base ref
  const detailsBlocks = bases.map(breakdownFor).join("");

  return `${markerFor(commentKey)}
### 📡 real network cost to ready${commentKey ? ` (${commentKey})` : ""}

True wire bytes from cold cache to \`performance.mark\`, network settled.

| ${headerCells.join(" | ")} |
| ${sepCells.join(" | ")} |
${rows.join("\n")}
${totalRow}
${spreadNote}${ignoredNote}${baseErrorNotes}${duplicateNotes}${comparedNote}
${detailsBlocks}
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
