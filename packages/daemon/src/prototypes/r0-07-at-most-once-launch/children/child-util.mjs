// R0-07 — shared helpers for the plain-node child scripts (bootstrap.mjs,
// fake-agent.mjs). Local import only; zero npm dependencies.

import { execFileSync } from "node:child_process";

/** Value of `--<name> <value>` in argv, or undefined. */
export const arg = (args, name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

/** macOS `ps -o lstart=` for one pid; null when unobservable. */
export const lstartOf = (pid) => {
  try {
    return execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 3000,
    }).trim();
  } catch {
    return null;
  }
};
