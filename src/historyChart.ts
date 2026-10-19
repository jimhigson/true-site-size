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
    name: `${r.emoji ? `${r.emoji} ` : ""}${r.name}`,
    valueOf: (e) => e.rows.find((x) => x.name === r.name)?.bytes,
  }));
  return { totals, rows };
};

/**
 * one mermaid xychart of a group of series, each plotted as its % change from
 * its own oldest value in the window. Bytes of different rows differ by orders
 * of magnitude, so on a shared byte axis the small rows flatten into lines;
 * relative change puts every series on one comparable scale, and the axis is
 * fitted to the data rather than pinned at zero so small moves stay visible.
 */
const chartFor = (
  title: string,
  series: Series[],
  points: HistoryEntry[],
  xLabels: string[],
  tagsAt: (string | undefined)[],
) => {
  const plotted = series.map((s) => {
    const raw = points.map(s.valueOf);
    const ref = raw.find((v) => v !== undefined);
    // a gap (an errored row) holds the line level, since mermaid needs a
    // value at every point; it's marked ✗ and the table shows the error
    let last = 0;
    const pcts = raw.map((v) => {
      if (v !== undefined && ref) last = round1(((v - ref) / ref) * 100);
      return last;
    });
    return { s, raw, pcts };
  });
  const all = plotted.flatMap((p) => p.pcts);
  const lo = Math.min(0, ...all);
  const hi = Math.max(0, ...all);
  const pad = Math.max((hi - lo) * 0.1, 0.5);
  const yMin = Math.floor(lo - pad);
  const yMax = Math.ceil(hi + pad);

  const lines = plotted.map(({ s, raw, pcts }, si) => {
    const values = pcts.map((pct, i) => {
      const labels = [
        // tags label the first line only - once per chart is enough to read
        si === 0 && tagsAt[i] ? `🏷️ ${tagsAt[i]}` : "",
        raw[i] === undefined ? "✗" : "",
        i === pcts.length - 1 ? signedPct(pct) : "",
      ].filter(Boolean);
      return labels.length ? `${pct} ${mq(labels.join(" "))}` : `${pct}`;
    });
    return `  line ${mq(s.name)} [${values.join(", ")}]`;
  });

  return `\`\`\`mermaid
---
config:
  xyChart:
    height: 360
    xAxis:
      labelRotation: 45
  themeVariables:
    xyChart:
      plotColorPalette: "${palette.slice(0, series.length).join(", ")}"
---
xychart-beta
  title ${mq(title)}
  x-axis [${xLabels.map(mq).join(", ")}]
  y-axis ${mq(`% change since ${xLabels[0]}`)} ${yMin} --> ${yMax}
${lines.join("\n")}
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
  const recorded = comparable.slice(-opts.length);
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

  const tagsAt = points.map((e) =>
    e === head ? undefined : opts.tags.get(e.sha)?.join(", "),
  );
  // x labels must be unique for mermaid to place each point on its own band
  const xLabels = points.map((e, i) =>
    e === head ? opts.headLabel
    : tagsAt[i] ? `🏷️ ${tagsAt[i]}`
    : e.pr !== null ? `#${e.pr}`
    : e.sha.slice(0, 7),
  );

  const { totals, rows } = seriesFor(newest);
  // with one row per visit, the rows chart would just repeat the totals
  const charts = [
    chartFor("totals", totals, points, xLabels, tagsAt),
    ...(rows.length > totals.filter((t) => t.name !== "💾 on disk").length ?
      [chartFor("per row", rows, points, xLabels, tagsAt)]
    : []),
  ];

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
      `\n<sub>✗ could not be measured at ${errored.map((e) => (e === head ? opts.headLabel : `\`${e.sha.slice(0, 7)}\``)).join(", ")} - the line holds level across the gap</sub>`
    : "";

  return `
${heading}

Bytes over the last ${recorded.length} commits on \`${opts.defaultBranch}\`${head ? ` and ${opts.headLabel}` : ""}, each line as its % change since the oldest shown. 🏷️ marks tagged commits.

${charts.join("\n\n")}
${erroredNote}${otherConfigNote}

<details><summary>commits</summary>

| ${header.join(" | ")} |
| ${header.map(() => "---").join(" | ")} |
${tableRows.join("\n")}

</details>
`;
};
