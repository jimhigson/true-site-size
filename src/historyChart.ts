import { formatBytes } from "./formatBytes.ts";

import type { HistoryEntry } from "./types.ts";

export interface HistoryChartOptions {
  /** only entries measured under this config are comparable */
  configHash: string;
  /** how many recorded commits to show (the head point is extra) */
  length: number;
  /** sha -> tag names */
  tags: Map<string, string[]>;
  /** the branch the history follows, named in the heading */
  defaultBranch: string;
  commitUrl: (sha: string) => string | null;
  prUrl: (n: number) => string | null;
  /** what to call the unrecorded head point (eg "this PR") */
  headLabel: string;
  commentKey: string;
  /** the journey's `chart` flags: visit indexes whose totals to chart and
   *  row names to chart. With neither set, every visit total is charted */
  charted: { visits: Set<number>; rows: Set<string> };
  /** which tags are releases (eg v1.2.0 but not nightly) */
  isRelease: (tag: string) => boolean;
  /** how many releases the releases chart shows */
  releases: number;
}

/**
 * line colours, in the same order as the comment's auto-assigned colour
 * circles (🟣 🟠 🔵 🟡 🟢 🔴 🟤 ⚫ ⚪), mid-tones that hold up on github's
 * light and dark backgrounds alike
 */
const palette = [
  "#8b5cf6",
  "#f97316",
  "#3b82f6",
  "#eab308",
  "#22c55e",
  "#ef4444",
  "#a16207",
  "#64748b",
  "#ec4899",
  "#14b8a6",
];

/** a plotted quantity: its legend name and how to read it from a point */
interface Series {
  name: string;
  /** the visit a total sums, or the row's name - what `chart` flags select */
  visit?: number;
  rowName?: string;
  valueOf: (e: HistoryEntry) => number | undefined;
}

/** mermaid strings are double-quoted and cannot escape a quote */
const mq = (s: string) => `"${s.replaceAll('"', "'")}"`;

/** markdown table cells cannot hold a pipe or newline */
const cell = (s: string) => s.replaceAll("|", "\\|").replaceAll("\n", " ");

const truncate = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;

const round1 = (n: number) => Math.round(n * 10) / 10;

const signedPct = (n: number) => `${n > 0 ? "+" : n < 0 ? "-" : "±"}${Math.abs(n).toFixed(1)}%`;

/**
 * the series to plot, read off the newest point's rows: each visit's total
 * (every row of the visit summed) and the whole-site disk size, then each row
 */
const seriesFor = (newest: HistoryEntry) => {
  const visits = [...new Set(newest.rows.map((r) => r.visit ?? 0))];
  const totals: Series[] = visits.map((v) => {
    const names = newest.rows.filter((r) => (r.visit ?? 0) === v).map((r) => r.name);
    const visitName = newest.rows.find((r) => (r.visit ?? 0) === v)?.visitName;
    return {
      visit: v,
      name: `total${visitName ? ` (${visitName})` : visits.length > 1 ? ` (visit ${v + 1})` : ""}`,
      valueOf: (e) => {
        const bytes = names.map((n) => e.rows.find((r) => r.name === n)?.bytes);
        return bytes.every((b) => b !== undefined) ?
            bytes.reduce((sum, b) => sum + b, 0)
          : undefined;
      },
    };
  });
  if (newest.disk !== null) {
    totals.push({ name: "💾 on disk", valueOf: (e) => e.disk ?? undefined });
  }
  const rows: Series[] = newest.rows.map((r) => ({
    rowName: r.name,
    name: `${r.emoji ? `${r.emoji} ` : ""}${r.name}`,
    valueOf: (e) => e.rows.find((x) => x.name === r.name)?.bytes,
  }));
  return { totals, rows };
};

/**
 * one mermaid xychart of a single series in kB. Sizes differ by orders of
 * magnitude (a 10 kB row beside a 5 MB site), so on a shared axis the small
 * ones flatten into lines - each series gets its own chart instead, its axis
 * fitted to its own range rather than pinned at zero so small moves show.
 * The title carries the latest size and its change across the window.
 */
const chartFor = (
  series: Series,
  colour: string,
  points: HistoryEntry[],
  xLabels: string[],
  tagsAt: (string | undefined)[],
) => {
  const raw = points.map(series.valueOf);
  const firstIndex = raw.findIndex((v) => v !== undefined);
  const first = raw[firstIndex];
  const latest = raw.findLast((v) => v !== undefined);
  // one measured point is no trend - and its "change" would read as ±0
  if (raw.filter((v) => v !== undefined).length < 2) return "";
  if (first === undefined || latest === undefined) return "";
  // a gap (an errored row) holds the line level, since mermaid needs a value
  // at every point; it's marked ✗ and the table shows the error
  let last = first;
  const kb = raw.map((v) => {
    if (v !== undefined) last = v;
    return round1(last / 1024);
  });
  const lo = Math.min(...kb);
  const hi = Math.max(...kb);
  // headroom for the point labels, and a floor so a flat line isn't all axis
  const pad = Math.max((hi - lo) * 0.15, hi * 0.005, 0.1);
  const yMin = Math.max(0, round1(lo - pad));
  const yMax = round1(hi + pad);

  const values = kb.map((v, i) => {
    const labels = [
      tagsAt[i] ? `🏷️ ${tagsAt[i]}` : "",
      // a run of gaps is marked once, where it starts
      raw[i] === undefined && (i === 0 || raw[i - 1] !== undefined) ? "✗" : "",
    ].filter(Boolean);
    return labels.length ? `${v} ${mq(labels.join(" "))}` : `${v}`;
  });
  const change = first ? ((latest - first) / first) * 100 : 0;
  const title = `${series.name}: ${formatBytes(latest)} (${signedPct(change)} since ${xLabels[firstIndex]})`;

  return `\`\`\`mermaid
---
config:
  xyChart:
    width: ${Math.max(700, points.length * 24)}
    height: 260
    titleFontSize: 16
    xAxis:
      labelRotation: 45
  themeVariables:
    xyChart:
      plotColorPalette: "${colour}"
---
xychart-beta
  title ${mq(title)}
  x-axis [${xLabels.map(mq).join(", ")}]
  y-axis "kB" ${yMin} --> ${yMax}
  line [${values.join(", ")}]
\`\`\``;
};

/** the comment's history section: charts over the recorded commits plus a
 *  table linking each one, or a short note while there is too little to plot */
export const formatHistory = (
  entries: HistoryEntry[],
  head: HistoryEntry | null,
  opts: HistoryChartOptions,
) => {
  const comparable = entries.filter(
    (e) => e.configHash === opts.configHash && e.sha !== head?.sha,
  );
  const otherConfig = new Set(
    entries.filter((e) => e.configHash !== opts.configHash).map((e) => e.sha),
  ).size;
  // the commits since the latest recorded release (inclusive), or the latest
  // history-length commits when no release is recorded - capped either way
  const lastReleaseIndex = comparable.findLastIndex((e) =>
    (opts.tags.get(e.sha) ?? []).some(opts.isRelease),
  );
  const recorded = comparable
    .slice(lastReleaseIndex === -1 ? 0 : lastReleaseIndex)
    .slice(-opts.length);
  const points = head ? [...recorded, head] : recorded;
  const heading = `### 📈 history${opts.commentKey ? ` (${opts.commentKey})` : ""}`;
  const otherConfigNote =
    otherConfig ?
      `\n<sub>${otherConfig} recorded commit(s) measured under a different config (journey, compression…) are not comparable and not shown - backfill to re-measure them</sub>`
    : "";

  // the series come from the newest point with rows - the head when present
  const newest = points.findLast((e) => e.rows.length > 0);
  if (points.length < 2 || !newest) {
    return `\n${heading}\n\n<sub>${comparable.length} commit(s) on \`${opts.defaultBranch}\` recorded so far - the chart appears once there are two points to join. Backfill to seed it.</sub>${otherConfigNote}\n`;
  }

  const { totals, rows } = seriesFor(newest);
  const flagged = opts.charted.visits.size + opts.charted.rows.size > 0;
  const chartedSeries =
    flagged ?
      [
        ...totals.filter((t) => t.visit !== undefined && opts.charted.visits.has(t.visit)),
        ...rows.filter((r) => opts.charted.rows.has(r.rowName!)),
      ]
    : totals.filter((t) => t.visit !== undefined);

  const tagsOf = (e: HistoryEntry) => (e === head ? [] : (opts.tags.get(e.sha) ?? []));
  /** a chart per charted series over these points; labelTags puts the tag
   *  names on the line as well as the axis (redundant when every point is one) */
  const chartsOver = (over: HistoryEntry[], labelTags: boolean) => {
    const tagsAt = over.map((e) => tagsOf(e).join(", ") || undefined);
    // x labels must be unique for mermaid to place each point on its own band
    const xLabels = over.map((e, i) =>
      e === head ? opts.headLabel
      : tagsAt[i] ? `🏷️ ${tagsAt[i]}`
      : e.pr !== null ? `#${e.pr}`
      : e.sha.slice(0, 7),
    );
    return chartedSeries
      .map(
        (sr, i) =>
          chartFor(
            sr,
            palette[i % palette.length]!,
            over,
            xLabels,
            labelTags ? tagsAt : over.map(() => undefined),
          ) ||
          `<sub>${sr.name}: fewer than two of these commits measured it, so there's no line to draw</sub>`,
      )
      .join("\n\n");
  };

  const releaseEntries = comparable.filter((e) => tagsOf(e).some(opts.isRelease));
  const lastRelease = releaseEntries.at(-1);
  const releaseName = lastRelease && tagsOf(lastRelease).find(opts.isRelease);
  const releasePoints = [
    ...releaseEntries.slice(-opts.releases),
    ...(head ? [head] : []),
  ];
  const releasesSection =
    releaseEntries.length >= (head ? 1 : 2) ?
      `\n#### 🏷️ last ${Math.min(releaseEntries.length, opts.releases)} release(s)${head ? ` and ${opts.headLabel}` : ""}\n\n${chartsOver(releasePoints, false)}\n`
    : `\n<sub>no recorded release yet for a releases chart - backfill \`releases:6\` to measure the latest releases</sub>\n`;
  const columns = [...totals, ...rows];
  const tableRows = [...points].reverse().map((e) => {
    const commitUrl = e === head ? null : opts.commitUrl(e.sha);
    const commit =
      e === head ? `*${opts.headLabel}*`
      : commitUrl ? `[\`${e.sha.slice(0, 7)}\`](${commitUrl})`
      : `\`${e.sha.slice(0, 7)}\``;
    const prUrl = e.pr !== null ? opts.prUrl(e.pr) : null;
    const pr =
      e.pr === null ? ""
      : prUrl ? `[#${e.pr}](${prUrl})`
      : `#${e.pr}`;
    const tags = e === head ? "" : (opts.tags.get(e.sha) ?? []).map((t) => `🏷️ ${t}`).join(" ");
    const message = e === head ? "" : cell(truncate(e.subject.replace(/\s*\(#\d+\)\s*$/, ""), 60));
    const values = columns.map((c) => {
      const v = c.valueOf(e);
      return v === undefined ? "✗" : formatBytes(v);
    });
    return `| ${[commit, pr, [tags, message].filter(Boolean).join(" "), ...values].join(" | ")} |`;
  });
  const header = ["commit", "PR", "message", ...columns.map((c) => c.name)];
  const errored = points.filter((e) => e.error || e.rows.some((r) => r.error));
  const erroredNote =
    errored.length ?
      `\n<sub>✗ marks where a line starts a gap - ${errored.length} commit(s) with something unmeasured, shown ✗ in the table. A line is drawn level across its gap, since the chart needs a value at every commit</sub>`
    : "";

  return `
${heading}

Bytes per commit on \`${opts.defaultBranch}\`, each chart's axis fitted to its own range. 🏷️ marks tags; the table has every size.

#### ${releaseName && lastReleaseIndex !== -1 && comparable.length - lastReleaseIndex <= opts.length ? `since ${releaseName}` : `last ${recorded.length} commits`}${head ? ` and ${opts.headLabel}` : ""}

${chartsOver(points, true)}
${releasesSection}${erroredNote}${otherConfigNote}

<details><summary>commits</summary>

| ${header.join(" | ")} |
| ${header.map(() => "---").join(" | ")} |
${tableRows.join("\n")}

</details>
`;
};
