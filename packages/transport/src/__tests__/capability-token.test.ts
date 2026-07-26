import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DevTokenFileTokenSource,
  KeychainTokenSource,
  type KeychainRunner,
} from "../capability-token.js";

// SV1-AUTH-07 / SV1-AUTH-03 — where the shared capability token comes from.
// DevTokenFile is the dev path (a 0600 file); KeychainTokenSource is the prod
// read path (write/ACL/access-group needs a signed binary — R0-02 boundary).

describe("DevTokenFileTokenSource (SV1-AUTH-07)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "af-token-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads the token bytes from a 0600 file", async () => {
    const path = join(dir, "token");
    const token = new Uint8Array([10, 20, 30, 40]);
    await writeFile(path, token);
    await chmod(path, 0o600);
    const src = new DevTokenFileTokenSource(path);
    expect(await src.read()).toEqual(token);
  });

  it("rejects a file whose permissions are looser than 0600", async () => {
    const path = join(dir, "token");
    await writeFile(path, new Uint8Array([1]));
    await chmod(path, 0o644);
    const src = new DevTokenFileTokenSource(path);
    await expect(src.read()).rejects.toThrow(/0600/);
  });

  it("rejects when the file is missing", async () => {
    const src = new DevTokenFileTokenSource(join(dir, "nope"));
    await expect(src.read()).rejects.toThrow();
  });
});

describe("KeychainTokenSource (SV1-AUTH-03 read path)", () => {
  const fakeRunner = (response: unknown): KeychainRunner => ({
    findGenericPassword: async () => response as never,
  });

  it("returns the token bytes when the entry exists", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const src = new KeychainTokenSource("af", "daemon", fakeRunner({ ok: true, bytes }));
    expect(await src.read()).toEqual(bytes);
  });

  it("throws when the entry is not found (read boundary — write/ACL is signed-binary)", async () => {
    const src = new KeychainTokenSource("af", "daemon", fakeRunner({ ok: false, code: "notFound" }));
    await expect(src.read()).rejects.toThrow();
  });
});
