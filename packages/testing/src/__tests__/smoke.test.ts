import type { StreamFrameHeader } from "@agents-fleet/contracts";
import { decodeFrame, encodeFrame } from "@agents-fleet/transport";
import { describe, expect, it } from "vitest";
import { FakeAdapter } from "../fake-adapter.js";
import { FakePty, invalidUtf8, nulBytes, splitMultibyte } from "../fake-pty.js";
import { withTempFs } from "../temp-fs.js";
import { withTempSqlite } from "../temp-sqlite.js";

const header = (payloadLength: number): StreamFrameHeader => ({
  frameType: "output",
  sessionId: "s" as never,
  generation: 1 as never,
  seq: 1 as never,
  payloadLength,
});

const concat = (chunks: readonly Uint8Array[]): Uint8Array => {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
};

describe("testing harness smoke", () => {
  it("FakePty bytes survive a binary-frame round-trip (split multibyte + NUL + invalid UTF-8)", () => {
    const pty = new FakePty();
    const received: Uint8Array[] = [];
    pty.onOutput((b) => received.push(b));
    for (const p of [...splitMultibyte("😀", 2), nulBytes(3), invalidUtf8()]) pty.emit(p);

    const combined = concat(received);
    const { payload } = decodeFrame(encodeFrame(header(combined.byteLength), combined));
    expect(Array.from(payload)).toEqual(Array.from(combined));
  });

  it("withTempFs creates the layout and cleans up", async () => {
    let captured: string | undefined;
    await withTempFs(async (layout) => {
      captured = layout.root;
      expect(layout.worktrees).toBeTruthy();
      expect(layout.chunks).toBeTruthy();
    });
    expect(captured).toBeTruthy();
  });

  it("withTempSqlite opens and round-trips a query", async () => {
    await withTempSqlite(async (db) => {
      const row = db.prepare("SELECT 1 AS n").get() as { n: number };
      expect(row.n).toBe(1);
    });
  });

  it("FakeAdapter.prepare returns a structured spec without executing (RT-ADAPTER-07)", async () => {
    const adapter = new FakeAdapter();
    const candidate = await adapter.discoverCandidate();
    const discovery = await adapter.discover({
      authorization: {
        trustId: "trust",
        trustVersion: 1,
        state: "Active",
        repositoryRoot: "/repository",
        repositoryIdentity: "repository-1",
      },
      candidate,
    });
    const permissionMapping = discovery.permissionMappings[1];
    if (permissionMapping === undefined) throw new Error("Balanced mapping is missing");
    const spec = await adapter.prepare({
      taskSpecHash: "h",
      discovery,
      profileSnapshot: {
        profileId: "profile-1" as never,
        profileVersion: 1,
        agentId: "fake",
        accountRef: null,
        model: null,
        mode: null,
        permissionMode: "Balanced",
        secretRefs: [],
        secretReferenceIdentities: [],
        adapterCapabilities: discovery.capabilities,
        adapterCapabilitiesHash: "capabilities-hash",
        permissionMapping,
        permissionMappingHash: "mapping-hash",
      },
      worktreeTarget: {
        kind: "Planned",
        worktreeId: "worktree-1" as never,
        canonicalPath: "/worktrees/task-1",
        repositoryIdentity: "repository-1",
        branchStrategy: {
          kind: "create",
          branchName: "fleet/task-1",
          onCollision: "fail",
        },
      },
    });
    expect(Array.isArray(spec.argv)).toBe(true);
    expect(spec.argv.length).toBeGreaterThan(0);
    expect(adapter.prepareCallCount).toBe(1);
  });
});
