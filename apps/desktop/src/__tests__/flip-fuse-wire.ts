// Test-only fuse flipper for the R0-11 attack fixture: returns a copy of an
// Electron Framework binary image with the given fuse flags flipped. Used on
// a throwaway clone of the app — never on the installed copy. It lives
// outside production Main code so a release build carries no fuse-mutation
// capability (SV1-ELECTRON-05 verifies; nothing in the app may rewrite).

import { FUSE_KEYS, FUSE_SENTINEL, type FuseState } from "../main/fuses.js";

/**
 * Return a copy of `binary` with the given fuse flags flipped. Length is
 * preserved (flags are single bytes), so the image stays structurally valid.
 */
export const flipFuseWire = (binary: Buffer, overrides: Partial<FuseState>): Buffer => {
  const sentinel = Buffer.from(FUSE_SENTINEL, "utf8");
  const offset = binary.indexOf(sentinel);
  if (offset < 0) throw new Error("fuse sentinel not found");
  const wireStart = offset + sentinel.length;
  const length = binary.readUInt8(wireStart + 1);
  if (length !== FUSE_KEYS.length) throw new Error("unexpected fuse wire length");
  const next = Buffer.from(binary);
  for (const [index, key] of FUSE_KEYS.entries()) {
    const value = overrides[key];
    if (value === undefined) continue;
    next.writeUInt8(value ? 0x31 : 0x30, wireStart + 2 + index); // '1' / '0'
  }
  return next;
};
