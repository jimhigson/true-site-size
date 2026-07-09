import { formatBytes } from "./formatBytes.ts";

import type {
  BaseRef,
  CommentOptions,
  DiskSizes,
  PostCommentOptions,
  RequestLogEntry,
  RowResult,
} from "./types.ts";

/**
 * each comment-key maintains its own comment on the pr, so one workflow can
 * report several measurements (eg a game and an editor build)
 */
const markerFor = (commentKey: string) =>
  `<!-- true-site-size${commentKey ? `:${commentKey}` : ""} -->`;

/**
 * column header for one base ref: the ref linked to the exact commit measured,
 * annotated with `git describe` when it names something other than the ref
 * itself (eg a branch shown as the release it descends from)
 */
const baseHeader = (b: BaseRef) => {
  const name = b.url ? `[${b.ref}](${b.url})` : `\`${b.ref}\``;
  const desc = b.describe && b.describe !== b.ref ? ` · ${b.describe}` : "";
  return `vs ${name}${desc}`;
};

/**
 * a colour per mark (journey row), shown as a circle next to its name wherever
 * it's referenced so a row is easy to follow across the table and breakdowns.
 * Assigned by row order; cycles once the palette is exhausted.
 */
const markColours = ["🟣", "🟠", "🔵", "🟡", "🟢", "🔴", "🟤", "⚫", "⚪"];
const markColour = (i: number) => markColours[i % markColours.length]!;

/**
 * the badge shown beside a row: the row's own `emoji` when the journey defined
 * one, otherwise the auto-assigned colour circle for its position
 */
const markBadge = (row: RowResult, i: number) => row.emoji ?? markColour(i);

/** build the markdown body for the PR comment */
export const formatComment = (
  /** per-scenario head results */
  head: RowResult[],
  /** array of base refs: { ref, sha, describe, url, results, error } */
  bases: BaseRef[],
  {
    runUrl,
    commentKey,
    stripHash,
    spreadToleranceBytes = 0,
    minimumChangeThreshold = 1,
    collapsibleBreakdown = true,
    headDisk = null,
    measureDisk = true,
  }: CommentOptions,
) => {
  const stripRe = stripHash ? new RegExp(stripHash, "g") : null;
  /** filename for matching across refs: pathname with the content hash removed */
  const fileOf = (url: string) => {
    const path = url.startsWith("blob:") ? "(blob)" : new URL(url).pathname;
    return stripRe ? path.replace(stripRe, ".") : path;
  };
  /** sum request bytes per hash-stripped file, skipping ignored requests */
  const filesOf = (requestLog: RequestLogEntry[] | undefined) => {
    const m = new Map<string, number>();
    for (const { url, bytes, ignored } of requestLog ?? []) {
      if (ignored) continue;
      const f = fileOf(url);
      m.set(f, (m.get(f) ?? 0) + bytes);
    }
    return m;
  };

  /** the base's row matching a head row by name (undefined if absent) */
  const baseRowFor = (b: BaseRef, name: string) =>
    b.results?.find((r) => r.name === name);

  /**
   * severity emoji for a size change, graded by the % - copied verbatim from
   * preactjs/compressed-size-action's iconForDifference. Increases warn
   * (🔍 ⚠️ 🚨 🆘), decreases celebrate (✅ 👏 🎉 🏆), and a change within ±5%
   * gets none.
   */
  const severityIcon = (delta: number, base: number) => {
    if (base === 0) return "🆕";
    const pct = Math.round((delta / base) * 100);
    if (pct >= 50) return "🆘";
    if (pct >= 20) return "🚨";
    if (pct >= 10) return "⚠️";
    if (pct >= 5) return "🔍";
    if (pct <= -50) return "🏆";
    if (pct <= -20) return "🎉";
    if (pct <= -10) return "👏";
    if (pct <= -5) return "✅";
    return "";
  };

  /**
   * a summary-table cell, stacked so each part reads on its own line: the delta
   * (with compressed-size-action's severity emoji), the relative % (with the
   * 📈/📉 trend emoji), then the base ("from") value. Markdown cells take <br>
   * for line breaks (a literal newline would break the row). Unchanged cells
   * keep the same three-line shape - a shrug, ±0 bytes and ±0.0%.
   */
  const deltaCell = (h: number, base: number) => {
    const was = `*was ${formatBytes(base)}*`;
    const d = h - base;
    if (d === 0 || Math.abs(d) < minimumChangeThreshold) {
      return `🤷 ±0 B<br>±0.0%<br>${was}`;
    }
    const pct = base === 0 ? 0 : Math.abs((d / base) * 100);
    const sign = d > 0 ? "+" : "-";
    const icon = severityIcon(d, base);
    const deltaLine = `${icon ? `${icon} ` : ""}${sign}${formatBytes(Math.abs(d))}`;
    const chart = d > 0 ? "📈" : "📉";
    return `${deltaLine}<br>${chart} ${sign}${pct.toFixed(1)}%<br>${was}`;
  };

  /** inline delta text for the per-file tables: severity icon + signed bytes
   *  + relative %, matching the summary cells' emoji scheme */
  const severityDelta = (h: number, base: number) => {
    const d = h - base;
    const icon = severityIcon(d, base);
    const sign = d > 0 ? "+" : "-";
    const pct = base === 0 ? 0 : Math.abs((d / base) * 100);
    return `${icon ? `${icon} ` : ""}${sign}${formatBytes(Math.abs(d))} (${sign}${pct.toFixed(1)}%)`;
  };

  /**
   * diff two file→bytes maps: { changed: the files whose bytes moved by at
   * least the threshold, biggest first; fileCount: size of their union }
   */
  const diffMaps = (
    headFiles: Map<string, number>,
    baseFiles: Map<string, number>,
  ) => {
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
    return { changed, fileCount: all.length };
  };

  /** per-file diff of a head row vs a base ref: { changed, unchangedCount },
   *  or null when the row or base could not be measured */
  const fileDiff = (h: RowResult, b: BaseRef) => {
    const br = baseRowFor(b, h.name);
    if (h.error || !br || br.error) return null;
    const { changed, fileCount } = diffMaps(
      filesOf(h.requestLog),
      filesOf(br.requestLog),
    );
    return { changed, unchangedCount: fileCount - changed.length };
  };

  /** the markdown table of a row's changed files vs a base ref */
  const fileTable = (
    b: BaseRef,
    changed: { f: string; hb: number | undefined; bb: number | undefined }[],
  ) => {
    const fileRows = changed.map(({ f, hb, bb }) => {
      const deltaTxt =
        bb === undefined ? `+${formatBytes(hb)}`
        : hb === undefined ? `-${formatBytes(bb)}`
        : severityDelta(hb, bb);
      const note =
        bb === undefined ? " 🆕"
        : hb === undefined ? " 🗑️"
        : "";
      return `| \`${f}\`${note} | ${formatBytes(hb)} | ${formatBytes(bb)} | ${deltaTxt} |`;
    });
    return `| file | PR | ${b.ref} | delta |\n| --- | --- | --- | --- |\n${fileRows.join("\n")}`;
  };

  /**
   * per-base-ref breakdown: a heading, then one entry per row. A row with no
   * changes is a plain line (nothing to reveal by expanding); a changed row is
   * a collapsible <details> by default, or shown inline when
   * collapsibleBreakdown is false. Empty when the base could not be measured.
   */
  const breakdownFor = (b: BaseRef) => {
    if (!b.results) return "";
    const entries = head
      .map((h, i) => {
        const diff = fileDiff(h, b);
        if (!diff) return null;
        const label = `${markBadge(h, i)} ${h.name}`;
        if (diff.changed.length === 0) {
          return `${label}: no per-file changes (${diff.unchangedCount} files identical)`;
        }
        const summary = `${label}: ${diff.changed.length} file(s) changed, ${diff.unchangedCount} identical`;
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

  // segments are incremental (each reports only its own bytes), so after each
  // one a cumulative "so far" row gives the running total to reach that point.
  // The last cumulative row is the journey's end total - there is no separate
  // total row. With a single segment the cumulative would just repeat it, so
  // it's omitted.
  const showCumulative = head.length > 1;

  /** the cumulative row after head segment i: the running total of segments
   *  0..i (labelled Σ), each base's delta measured against its own running
   *  total. The final one is the journey's end total, labelled **total** and
   *  bolded. A cell is "—" whenever a segment it sums could not be measured */
  const cumulativeRow = (i: number) => {
    const isEndTotal = i === head.length - 1;
    const upTo = head.slice(0, i + 1);
    const headCum =
      upTo.every((r) => !r.error) ?
        upTo.reduce((a, r) => a + r.bytes!, 0)
      : null;
    const prCell =
      headCum === null ? "—"
      : isEndTotal ? `**${formatBytes(headCum)}**`
      : formatBytes(headCum);
    const baseCells = bases.map((b) => {
      if (headCum === null || !b.results) return "—";
      const baseRows = upTo.map((h) => baseRowFor(b, h.name));
      if (baseRows.some((br) => !br || br.error)) return "—";
      const baseCum = baseRows.reduce((a, br) => a + br!.bytes!, 0);
      return deltaCell(headCum, baseCum);
    });
    const label = isEndTotal ? "**total**" : "Σ";
    return `| ${[label, prCell, ...baseCells].join(" | ")} |`;
  };

  const rows = head.flatMap((h, i) => {
    const prCell =
      h.error ? `⚠️ unable to measure - ${h.error}` : formatBytes(h.bytes);
    const baseCells = bases.map((b) => {
      if (h.error) return "—";
      const br = baseRowFor(b, h.name);
      if (!br || br.error) return "—";
      return deltaCell(h.bytes!, br.bytes!);
    });
    const segmentRow = `| ${[`${markBadge(h, i)} ${h.name}`, prCell, ...baseCells].join(" | ")} |`;
    // the cumulative after the first segment just repeats it, so it starts
    // from the second
    return showCumulative && i > 0 ? [segmentRow, cumulativeRow(i)] : [segmentRow];
  });

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
      const transfers = new Map<string, number[]>();
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

  // ── total built size on disk: every file in serve-dir, loaded or not,
  // compressed as served. headDisk / base.disk are { total, files } or null.
  /** a disk { files } as a hash-stripped path→bytes map (matches across builds) */
  const diskFilesOf = (disk: DiskSizes | null | undefined) => {
    const m = new Map<string, number>();
    for (const [path, bytes] of Object.entries(disk?.files ?? {})) {
      const f = stripRe ? path.replace(stripRe, ".") : path;
      m.set(f, (m.get(f) ?? 0) + bytes);
    }
    return m;
  };
  /** changed-files breakdown of the whole serve-dir vs one base ref */
  const diskBreakdownFor = (b: BaseRef) => {
    if (!headDisk || !b.disk) return "";
    const { changed, fileCount } = diffMaps(
      diskFilesOf(headDisk),
      diskFilesOf(b.disk),
    );
    const heading = `\n#### ${baseHeader(b)}\n\n`;
    if (changed.length === 0) {
      return `${heading}no per-file changes (${fileCount} files identical)\n`;
    }
    const summary = `${changed.length} file(s) changed, ${fileCount - changed.length} identical`;
    const table = fileTable(b, changed);
    return collapsibleBreakdown ?
        `${heading}<details><summary>${summary}</summary>\n\n${table}\n</details>\n`
      : `${heading}${summary}\n\n${table}\n`;
  };
  const diskHeader = ["", "PR", ...bases.map(baseHeader)];
  const diskTotalRow =
    headDisk ?
      `| ${[
        "**on disk**",
        `**${formatBytes(headDisk.total)}**`,
        ...bases.map((b) =>
          b.disk ? deltaCell(headDisk.total, b.disk.total) : "—",
        ),
      ].join(" | ")} |`
    : "";
  const diskSection =
    measureDisk && headDisk ?
      `\n### 💾 total built size on disk${commentKey ? ` (${commentKey})` : ""}

Every file in the built site, loaded or not, compressed as served.

| ${diskHeader.join(" | ")} |
| ${diskHeader.map(() => "---").join(" | ")} |
${diskTotalRow}
${bases.length === 0 ? "<sub>no base ref to compare against - showing head only</sub>\n" : ""}${bases.map(diskBreakdownFor).join("")}`
    : "";

  return `${markerFor(commentKey)}
### 📡 real network cost to ready${commentKey ? ` (${commentKey})` : ""}

True wire bytes from cold cache to \`performance.mark\`, network settled.

| ${headerCells.join(" | ")} |
| ${sepCells.join(" | ")} |
${rows.join("\n")}
${spreadNote}${ignoredNote}${baseErrorNotes}${duplicateNotes}${comparedNote}
${detailsBlocks}
${diskSection}
${runUrl ? `\n<sub>📋 per-request breakdown (every url, size and timing) is in the [run logs](${runUrl})</sub>` : ""}
<sub>measured by [true-site-size](https://github.com/jimhigson/true-site-size)</sub>
`;
};

/** create or update the marker-identified comment on the PR */
export const postComment = async (
  body: string,
  {
    token,
    repo,
    issueNumber,
    commentKey,
    apiUrl = "https://api.github.com",
  }: PostCommentOptions,
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
  const existing = ((await listRes.json()) as { id: number; body?: string }[]).find(
    (c) => c.body?.includes(marker),
  );
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
