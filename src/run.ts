import { execSync } from "node:child_process";

/** run a command in a directory, announcing it and letting its output through */
export const run = (cmd: string, cwd: string) => {
  console.log(`[true-site-size] $ ${cmd} (in ${cwd})`);
  execSync(cmd, { cwd, stdio: "inherit" });
};

/**
 * run a command for its trimmed stdout, with nothing announced and nothing
 * written to the log - for probes whose failure is an expected answer rather
 * than something to report (execSync's default lets the child's stderr
 * through, which would print eg git's "fatal: ..." for a question we asked)
 */
export const runQuiet = (cmd: string, cwd: string) =>
  execSync(cmd, { cwd, stdio: "pipe" }).toString().trim();
