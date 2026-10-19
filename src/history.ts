import { execSync } from "node:child_process";

import { run, runQuiet } from "./run.ts";

import type {
  DiskSizes,
  HistoryEntry,
  HistoryRow,
  RowResult,
} from "./types.ts";

/**
 * The history lives as one json file per comment-key on an orphan branch of
 * the measured repo itself: durable, versioned, and readable by any run that
 * can fetch - including PRs from forks, which only ever read it. Writes go
 * through git plumbing (hash-object / mktree / commit-tree / push) so the
 * branch never has to be checked out and the workspace is left untouched.
 */

/** private ref the branch is fetched into - leaves FETCH_HEAD alone for the
 *  base-ref code, which reads it straight after its own fetch */
const historyRef = "refs/true-site-size/history";

/** the history file for a comment-key: each key measures its own journey */
export const historyFileFor = (commentKey: string) =>
  `history${commentKey ? `-${commentKey.replace(/[^\w.-]+/g, "_")}` : ""}.json`;

/** the history can outgrow execSync's 1MB default output buffer */
const gitOut = (cmd: string, cwd: string, input?: string) =>
  execSync(cmd, {
    cwd,
    input,
    stdio: "pipe",
    maxBuffer: 256 * 1024 * 1024,
  })
    .toString()
    .trim();

/** fetch the history branch tip; null when the branch does not exist yet */
const fetchHistoryTip = (workspace: string, branch: string) => {
  try {
    runQuiet(
      `git fetch --depth=1 --no-tags origin +refs/heads/${branch}:${historyRef}`,
      workspace,
    );
    return runQuiet(`git rev-parse ${historyRef}`, workspace);
  } catch {
    return null;
  }
};

const entriesAt = (workspace: string, tip: string | null, file: string) => {
  if (!tip) return [];
  try {
    return (JSON.parse(gitOut(`git show ${tip}:${file}`, workspace)) as {
      entries: HistoryEntry[];
    }).entries;
  } catch {
    // the branch exists but has no file for this key yet
    return [];
  }
};

/** the recorded history for a comment-key's file, oldest first */
export const readHistory = (workspace: string, branch: string, file: string) =>
  entriesAt(workspace, fetchHistoryTip(workspace, branch), file);

/**
 * fold new entries into recorded ones: a commit re-measured under the same
 * config replaces its old entry, and the whole sorts oldest first
 */
export const mergeEntries = (
  existing: HistoryEntry[],
  added: HistoryEntry[],
) => {
  const keyOf = (e: HistoryEntry) => `${e.sha}:${e.configHash}`;
  const byKey = new Map(existing.map((e) => [keyOf(e), e]));
  for (const e of added) byKey.set(keyOf(e), e);
  return [...byKey.values()].sort((a, z) => a.date.localeCompare(z.date));
};

/** one entry per line, so the branch's git log diffs read as added commits */
const serialise = (entries: HistoryEntry[]) =>
  `{"version":1,"entries":[\n${entries.map((e) => JSON.stringify(e)).join(",\n")}\n]}\n`;

const botIdentity = {
  GIT_AUTHOR_NAME: "github-actions[bot]",
  GIT_AUTHOR_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
  GIT_COMMITTER_NAME: "github-actions[bot]",
  GIT_COMMITTER_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
};

/**
 * append entries to the history branch and push. Concurrent writers (a
 * backfill racing a push to main) lose the race with a non-fast-forward
 * rejection, so each attempt re-reads the tip and re-applies its entries
 */
export const appendHistory = (
  workspace: string,
  branch: string,
  file: string,
  added: HistoryEntry[],
) => {
  const attempts = 5;
  for (let attempt = 1; ; attempt++) {
    const tip = fetchHistoryTip(workspace, branch);
    const entries = mergeEntries(entriesAt(workspace, tip, file), added);
    const blob = gitOut("git hash-object -w --stdin", workspace, serialise(entries));
    // keep the other comment-keys' files alongside this one
    const others =
      tip ?
        gitOut(`git ls-tree ${tip}`, workspace)
          .split("\n")
          .filter((line) => line && !line.endsWith(`\t${file}`))
      : [];
    const tree = gitOut(
      "git mktree",
      workspace,
      [...others, `100644 blob ${blob}\t${file}`].join("\n") + "\n",
    );
    const message = `record ${added.map((e) => e.sha.slice(0, 9)).join(", ")} in ${file}`;
    const commit = execSync(
      `git commit-tree ${tree}${tip ? ` -p ${tip}` : ""} -m "${message}"`,
      { cwd: workspace, stdio: "pipe", env: { ...process.env, ...botIdentity } },
    )
      .toString()
      .trim();
    try {
      runQuiet(`git push origin ${commit}:refs/heads/${branch}`, workspace);
      console.log(`[true-site-size] history: ${message} (${branch})`);
      return;
    } catch (e) {
      if (attempt >= attempts) {
        throw new Error(
          `could not push the history branch ${branch} after ${attempts} attempts (does the workflow grant contents: write?): ${(e as Error).message}`,
        );
      }
      console.warn(
        `[true-site-size] history push rejected (attempt ${attempt}/${attempts}) - re-reading the branch and retrying`,
      );
    }
  }
};

/**
 * the PR a commit merged, from its subject: squash merges end "(#123)" and
 * merge commits start "Merge pull request #123"
 */
const prOfSubject = (subject: string) => {
  const n =
    /\(#(\d+)\)\s*$/.exec(subject)?.[1] ??
    /^Merge pull request #(\d+)/.exec(subject)?.[1];
  return n ? Number(n) : null;
};

/** a history entry for a measured (or unmeasurable) commit */
export const historyEntry = (
  workspace: string,
  sha: string,
  configHash: string,
  measured: { results: RowResult[]; disk: DiskSizes | null } | { error: string },
): HistoryEntry => {
  const [epoch = "0", subject = ""] = runQuiet(
    `git show -s --format=%ct%n%s ${sha}`,
    workspace,
  ).split("\n");
  // in UTC, so the dates sort as strings whatever zone each was committed in
  const date = new Date(Number(epoch) * 1000).toISOString();
  const base = { sha, date, subject, pr: prOfSubject(subject), configHash };
  if ("error" in measured) {
    return { ...base, rows: [], disk: null, error: measured.error };
  }
  const rows = measured.results.map(
    ({ name, bytes, visit, visitName, emoji, error }): HistoryRow => ({
      name,
      ...(error ? { error } : { bytes: bytes! }),
      ...(visit !== undefined && { visit }),
      ...(visitName !== undefined && { visitName }),
      ...(emoji !== undefined && { emoji }),
    }),
  );
  return { ...base, rows, disk: measured.disk?.total ?? null };
};

/** sha -> tag names, from origin so tags made after recording still show */
export const remoteTags = (workspace: string) => {
  const tags = new Map<string, string[]>();
  let listing = "";
  try {
    listing = gitOut("git ls-remote --tags origin", workspace);
  } catch {
    return tags;
  }
  // an annotated tag lists its tag object, then the commit it peels to as
  // "<tag>^{}" - only the peeled line names the commit
  const lines = listing.split("\n").map((l) => l.split("\t") as [string, string]);
  const peeled = new Set(
    lines.filter(([, ref]) => ref?.endsWith("^{}")).map(([, ref]) => ref.slice(0, -3)),
  );
  for (const [sha, ref] of lines) {
    if (!ref || (peeled.has(ref) && !ref.endsWith("^{}"))) continue;
    const name = ref.replace(/^refs\/tags\//, "").replace(/\^\{\}$/, "");
    tags.set(sha, [...(tags.get(sha) ?? []), name]);
  }
  return tags;
};

/**
 * the first-parent commits a backfill spec names, newest first (so a backfill
 * cut short still has the most recent history). The spec is a range "A..B"
 * whose ends resolve locally or on origin (eg "v26.0.0..main"), or a count N
 * of the default branch's most recent commits
 */
export const backfillCommits = (
  workspace: string,
  spec: string,
  defaultBranch: string,
) => {
  // ci checkouts are shallow and carry only the triggering ref; a range needs
  // real history, its tags, and the default branch to resolve against
  const shallow = runQuiet("git rev-parse --is-shallow-repository", workspace) === "true";
  run(
    `git fetch --tags${shallow ? " --unshallow" : ""} origin +refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`,
    workspace,
  );
  const resolve = (name: string) => {
    for (const candidate of [name, `origin/${name}`]) {
      try {
        return runQuiet(`git rev-parse --verify --quiet ${candidate}^{commit}`, workspace);
      } catch {
        // try the next spelling
      }
    }
    throw new Error(`backfill: cannot resolve "${name}" to a commit`);
  };
  const trimmed = spec.trim();
  const revs =
    /^\d+$/.test(trimmed) ?
      `--max-count=${trimmed} origin/${defaultBranch}`
    : (() => {
        const [from, to] = trimmed.split("..");
        if (!from || !to) {
          throw new Error(
            `backfill: expected a range "A..B" or a commit count, got "${spec}"`,
          );
        }
        return `${resolve(from)}..${resolve(to)}`;
      })();
  return gitOut(`git rev-list --first-parent ${revs}`, workspace)
    .split("\n")
    .filter(Boolean);
};
