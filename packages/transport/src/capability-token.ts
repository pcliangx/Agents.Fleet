// SV1-AUTH-03 / SV1-AUTH-07 — where the shared capability token comes from.
// Both peers (Daemon + Electron Main) read the SAME token: a Keychain entry
// (prod, shared access group) or a dev token file (dev, separate 0600 file).
// The token is never sent over the transport; it only keys the proof MAC.
//
// The Keychain WRITE / ACL / access-group path needs a signed binary and is the
// R0-02 boundary — only the READ path is implemented here.

import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface CapabilityTokenSource {
  read(): Promise<Uint8Array>;
}

// SV1-AUTH-07 — dev token file. Must be 0600 and must not reuse a production
// Keychain entry.
export class DevTokenFileTokenSource implements CapabilityTokenSource {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async read(): Promise<Uint8Array> {
    const st = await stat(this.path);
    if ((st.mode & 0o777) !== 0o600) {
      throw new Error(`dev token file must be 0600 (got 0${(st.mode & 0o777).toString(8)})`);
    }
    return new Uint8Array(await readFile(this.path));
  }
}

export type KeychainLookup =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly code: "notFound" | "failed" };

export interface KeychainRunner {
  findGenericPassword(service: string, account: string): Promise<KeychainLookup>;
}

// SV1-AUTH-03 — prod read path. Spawns the macOS `security` CLI (R0-02
// confirmed reachable from a LaunchAgent). The entry itself is created by the
// signed installer (write/ACL boundary, not implemented here).
export const securityKeychainRunner: KeychainRunner = {
  async findGenericPassword(service, account): Promise<KeychainLookup> {
    try {
      const { stdout } = await execFileP("/usr/bin/security", [
        "find-generic-password",
        "-s",
        service,
        "-a",
        account,
        "-w",
      ]);
      // `security -w` appends a trailing newline; the stored token is a
      // UTF-8 string (e.g. base64). Binary token round-trip is a refinement.
      return { ok: true, bytes: new Uint8Array(Buffer.from(stdout.replace(/\n$/, ""), "utf8")) };
    } catch (e: unknown) {
      const err = e as { code?: number; stderr?: string };
      // exit 44 == "could not be found in the keychain"
      if (err.code === 44 || /could not be found/.test(String(err.stderr ?? ""))) {
        return { ok: false, code: "notFound" };
      }
      return { ok: false, code: "failed" };
    }
  },
};

export class KeychainTokenSource implements CapabilityTokenSource {
  constructor(
    private readonly service: string,
    private readonly account: string,
    private readonly runner: KeychainRunner,
  ) {}

  async read(): Promise<Uint8Array> {
    const r = await this.runner.findGenericPassword(this.service, this.account);
    if (!r.ok) {
      throw new Error(`keychain capability token not available (${r.code})`);
    }
    return r.bytes;
  }
}
