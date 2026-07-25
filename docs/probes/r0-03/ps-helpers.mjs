// Shared `ps` identity parser for the R0-03 probe scripts (probe.mjs +
// daemon-worker.mjs). Reads the full process identity Reconciliation will use.
//
// macOS `ps`: trailing `=` strips the header. `lstart` is the only multi-token
// field and sits between `sess` and `tty`. Returns null if the pid is gone or
// ps fails — callers treat null as "could not observe".

import { execFileSync } from "node:child_process";

export function parsePs(pid) {
  let raw;
  try {
    raw = execFileSync("/bin/ps", ["-o", "pid=,ppid=,pgid=,sess=,lstart=,tty=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 3000,
    }).trim();
  } catch {
    return null;
  }
  if (!raw) return null;
  const tok = raw.split(/\s+/).filter(Boolean);
  const [p, pp, pg, sess, ...rest] = tok;
  const tty = rest[rest.length - 1];
  const lstart = rest.slice(0, -1).join(" ");
  return { pid: Number(p), ppid: Number(pp), pgid: Number(pg), sess: Number(sess), lstart, tty };
}
