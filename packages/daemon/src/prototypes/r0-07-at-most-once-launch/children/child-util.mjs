// R0-07 — shared helpers for the plain-node child scripts (bootstrap.mjs,
// fake-agent.mjs). Local import only; zero npm dependencies.

import { execFileSync } from "node:child_process";

/** Value of `--<name> <value>` in argv, or undefined. */
export const arg = (args, name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

/**
 * macOS `ps -o lstart=` for one pid; null when unobservable.
 *
 * Internal whitespace is normalized to single spaces so this matches parsePs's
 * split/join normalization. `ps -o lstart=` formats the day with `%e`
 * (blank-padded), emitting a double space before single-digit days
 * (e.g. "Wed  5 Jul 09:10:43 2026"); bare trim() only strips the ends, leaving
 * the double space and breaking the RT-LAUNCH-02 identity comparison (#66).
 */
export const lstartOf = (pid) => {
  try {
    return execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 3000,
    })
      .trim()
      .split(/\s+/)
      .join(" ");
  } catch {
    return null;
  }
};
