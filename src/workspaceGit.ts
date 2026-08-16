import { rmSync } from "node:fs";

import { run, runQuiet } from "./run.ts";

/**
 * can git operate on the workspace at all? A checkout that is itself a git
 * worktree has a `.git` *file* naming an absolute gitdir elsewhere on the
 * host; when the workspace is used as-is rather than cloned (as under `act`,
 * which mounts the directory into the container) that path is not there and
 * every git command fails with "fatal: not a git repository: (null)".
 */
const gitIsUsable = (workspace: string) => {
  try {
    runQuiet("git rev-parse --git-dir", workspace);
    return true;
  } catch {
    return false;
  }
};

/**
 * why base refs cannot be measured in this workspace, or null when they can.
 * Measuring a base is destructive - it runs clean-command in the workspace and
 * adds a git worktree inside it - which is what a throwaway ci checkout is
 * for, and exactly what a developer's live checkout must be spared. A
 * head-only report is far more use than a failed job, so both answers here
 * degrade the run rather than ending it.
 */
export const baseComparisonBlocker = (workspace: string): string | null => {
  if (process.env["ACT"] && !process.env["TRUE_SITE_SIZE_ALLOW_DESTRUCTIVE"]) {
    return "running locally under act, where the workspace can be your own working directory (`act --bind`) - measuring a base would run clean-command in it and add a git worktree inside it. Set TRUE_SITE_SIZE_ALLOW_DESTRUCTIVE=1 to compare anyway, on a checkout you are happy to lose";
  }
  if (!gitIsUsable(workspace)) {
    return "the workspace is not a usable git repository (a git worktree checkout, whose .git file points at a gitdir that is not here?)";
  }
  return null;
};

/** worktrees added by this process, keyed by path -> the workspace owning them */
const addedWorktrees = new Map<string, string>();

const removeAll = () => {
  for (const [dir, workspace] of addedWorktrees) removeBaseWorktree(workspace, dir);
};

let cleanupHandlersRegistered = false;
/**
 * make the added worktrees outlive nothing: an interrupted or hard-timed-out
 * run would otherwise leave one registered in the workspace for the developer
 * to remove by hand. The handlers only run synchronous work, as "exit"
 * requires
 */
const registerCleanupHandlers = () => {
  if (cleanupHandlersRegistered) return;
  cleanupHandlersRegistered = true;
  process.on("exit", removeAll);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      removeAll();
      process.exit(1);
    });
  }
};

/** check `commitish` out into `dir` as a detached worktree of the workspace repo */
export const addBaseWorktree = (
  workspace: string,
  dir: string,
  commitish: string,
) => {
  registerCleanupHandlers();
  rmSync(dir, { recursive: true, force: true });
  // a run killed before its own cleanup could have left the path registered
  try {
    runQuiet("git worktree prune", workspace);
  } catch {
    // pruning is opportunistic; the add below reports anything really wrong
  }
  addedWorktrees.set(dir, workspace);
  run(`git worktree add --detach ${dir} ${commitish}`, workspace);
};

/** remove a base worktree and deregister it; tolerates it never having existed */
export const removeBaseWorktree = (workspace: string, dir: string) => {
  addedWorktrees.delete(dir);
  try {
    run(`git worktree remove --force ${dir}`, workspace);
  } catch {
    // never added, or already gone - the prune below settles the registration
  }
  rmSync(dir, { recursive: true, force: true });
  try {
    runQuiet("git worktree prune", workspace);
  } catch {
    // no usable git here, so nothing is registered either
  }
};
