// R0-07 — full process identity probing (RT-REC-12: {pid, lstart, pgid,
// command}, never PID alone). Ported from docs/probes/r0-03/ps-helpers.mjs
// and extended with the command column so Reconciliation can also match the
// executable, not just numeric identity.

import { execFileSync } from "node:child_process";

export interface ProcessIdentity {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  /** macOS `ps -o lstart=` — process start time, stable for the lifetime. */
  readonly lstart: string;
  /** Full argv (command column) — matched against the expected executable. */
  readonly command: string;
}

/**
 * Full identity of one pid, or null when the pid is gone / unobservable.
 * Callers treat null as "could not observe", never as "does not exist".
 */
export const parsePs = (pid: number): ProcessIdentity | null => {
  let raw: string;
  try {
    raw = execFileSync("/bin/ps", ["-o", "pid=,ppid=,pgid=,lstart=,command=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 3000,
    }).trim();
  } catch {
    return null;
  }
  if (!raw) return null;
  const tok = raw.split(/\s+/).filter(Boolean);
  // pid ppid pgid <lstart: 5 tokens "Www Mmm DD hh:mm:ss yyyy"> command...
  if (tok.length < 3 + 5 + 1) return null;
  const [p, pp, pg] = tok;
  return {
    pid: Number(p),
    ppid: Number(pp),
    pgid: Number(pg),
    lstart: tok.slice(3, 8).join(" "),
    command: tok.slice(8).join(" "),
  };
};

export interface ExpectedIdentity {
  readonly pid: number;
  readonly pgid?: number | undefined;
  readonly lstart?: string | undefined;
  readonly commandIncludes?: readonly string[] | undefined;
}

/** RT-REC-12 — re-identification by FULL identity, not PID alone. */
export const matchesFullIdentity = (
  observed: ProcessIdentity,
  expected: ExpectedIdentity,
): boolean => {
  if (observed.pid !== expected.pid) return false;
  if (expected.pgid !== undefined && observed.pgid !== expected.pgid) return false;
  if (expected.lstart !== undefined && observed.lstart !== expected.lstart) return false;
  for (const needle of expected.commandIncludes ?? []) {
    if (!observed.command.includes(needle)) return false;
  }
  return true;
};

export const probeProcess = (
  pid: number,
  expected: Omit<ExpectedIdentity, "pid">,
): { readonly found: boolean; readonly observed: ProcessIdentity | null } => {
  const observed = parsePs(pid);
  if (observed === null) return { found: false, observed: null };
  return { found: matchesFullIdentity(observed, { pid, ...expected }), observed };
};

/** Global scan for live processes whose command contains every needle. */
export const scanProcesses = (needles: readonly string[]): readonly ProcessIdentity[] => {
  let raw: string;
  try {
    raw = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,lstart=,command="], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return [];
  }
  const out: ProcessIdentity[] = [];
  for (const line of raw.split("\n")) {
    const tok = line.trim().split(/\s+/).filter(Boolean);
    if (tok.length < 3 + 5 + 1) continue;
    const command = tok.slice(8).join(" ");
    if (!needles.every((n) => command.includes(n))) continue;
    out.push({
      pid: Number(tok[0]),
      ppid: Number(tok[1]),
      pgid: Number(tok[2]),
      lstart: tok.slice(3, 8).join(" "),
      command,
    });
  }
  return out;
};

export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Process identity as RECORDED by a child of the launch protocol (durable
 * receipt per RT-LAUNCH-02, agent self-identity per RT-LAUNCH-04). Verified
 * against live `ps` output via matchesFullIdentity (RT-REC-12).
 */
export interface RecordedProcessIdentity {
  readonly nonce: string;
  readonly pid: number;
  readonly pgid: number;
  readonly lstart: string;
  readonly argvHash: string;
}
