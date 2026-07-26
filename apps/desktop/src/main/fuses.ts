// SV1-ELECTRON-05 — Electron fuse wire reader and release-posture verifier.
//
// The fuse wire is embedded in the Electron Framework binary (macOS:
// `Electron Framework.framework/Versions/Current/Electron Framework`) as:
//   sentinel "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX"
//   1 byte  fuse wire version (currently 1)
//   1 byte  fuse wire length (8 — one ASCII '0'/'1' flag per fuse)
//   N bytes flags in FuseKey order
// (Format confirmed empirically against Electron 34.5.8: wire "10110001",
// matching Electron's shipped defaults.)
//
// Release builds must fail closed on any violation or on an unparseable wire.
// Full verification (fuse state + asar integrity + bundle manifest) only
// holds after signing/notarization — see docs/probes/r0-11-electron-boundary.md.

import { dirname, join } from "node:path";

export const FUSE_SENTINEL = "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX";
export const FUSE_WIRE_VERSION = 1;
export const FUSE_KEYS = [
  "RunAsNode",
  "EnableCookieEncryption",
  "EnableNodeOptionsEnvironmentVariable",
  "EnableNodeCliInspectArguments",
  "EnableEmbeddedAsarIntegrityValidation",
  "OnlyLoadAppFromAsar",
  "LoadBrowserProcessSpecificV8Snapshot",
  "GrantFileProtocolExtraPrivileges",
] as const;

export type FuseKey = (typeof FUSE_KEYS)[number];

/**
 * Required release posture (SV1-ELECTRON-05): no RunAsNode, no
 * NODE_OPTIONS / CLI-inspect injection, asar integrity + app-only-from-asar
 * on, no browser-process V8 snapshot from outside the bundle, no extra
 * file:// privileges. EnableCookieEncryption goes beyond the contract minimum
 * but is required by our release policy (protects cookies at rest).
 */
export const REQUIRED_RELEASE_FUSES: Readonly<Record<FuseKey, boolean>> = {
  RunAsNode: false,
  EnableCookieEncryption: true,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
  LoadBrowserProcessSpecificV8Snapshot: false,
  GrantFileProtocolExtraPrivileges: false,
};

export type FuseState = Readonly<Record<FuseKey, boolean>>;

export interface FuseReport {
  readonly parseable: boolean;
  readonly wireVersion: number | null;
  readonly fuses: FuseState | null;
  /** Human-readable violations against REQUIRED_RELEASE_FUSES. */
  readonly violations: readonly string[];
  readonly compliant: boolean;
}

/** Locate and parse the fuse wire in an Electron Framework binary image. */
export const parseFuseWire = (binary: Buffer): { version: number; fuses: FuseState } | null => {
  const sentinel = Buffer.from(FUSE_SENTINEL, "utf8");
  const offset = binary.indexOf(sentinel);
  if (offset < 0) return null;
  const wireStart = offset + sentinel.length;
  if (wireStart + 2 > binary.length) return null;
  const version = binary.readUInt8(wireStart);
  const length = binary.readUInt8(wireStart + 1);
  if (version !== FUSE_WIRE_VERSION || length !== FUSE_KEYS.length) return null;
  if (wireStart + 2 + length > binary.length) return null;
  const flags = binary.subarray(wireStart + 2, wireStart + 2 + length).toString("utf8");
  if (!/^[01]+$/.test(flags)) return null;
  const fuses = Object.fromEntries(
    FUSE_KEYS.map((key, index) => [key, flags[index] === "1"]),
  ) as Record<FuseKey, boolean>;
  return { version, fuses };
};

/** Verify a binary image against the required release posture. */
export const verifyReleaseFuses = (binary: Buffer): FuseReport => {
  const parsed = parseFuseWire(binary);
  if (parsed === null) {
    // Fail closed: a binary whose fuse wire cannot be proven is non-compliant.
    return {
      parseable: false,
      wireVersion: null,
      fuses: null,
      violations: ["fuse wire not found or unparseable"],
      compliant: false,
    };
  }
  const violations = FUSE_KEYS.filter(
    (key) => parsed.fuses[key] !== REQUIRED_RELEASE_FUSES[key],
  ).map(
    (key) =>
      `${key}: required ${REQUIRED_RELEASE_FUSES[key] ? "on" : "off"}, found ${parsed.fuses[key] ? "on" : "off"}`,
  );
  return {
    parseable: true,
    wireVersion: parsed.version,
    fuses: parsed.fuses,
    violations,
    compliant: violations.length === 0,
  };
};

/**
 * Return a copy of `binary` with the given fuse flags flipped. Length is
 * preserved (flags are single bytes), so the image stays structurally valid.
 * Used by the R0 attack fixture on a throwaway clone of the app — never on
 * the installed copy.
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

/**
 * Default location of the fuse-carrying binary for a macOS Electron.app:
 * given `.../Electron.app/Contents/MacOS/Electron`, return the Electron
 * Framework binary path.
 */
export const frameworkBinaryPath = (electronExecutablePath: string): string => {
  const contentsDir = dirname(dirname(electronExecutablePath));
  return join(
    contentsDir,
    "Frameworks",
    "Electron Framework.framework",
    "Versions",
    "Current",
    "Electron Framework",
  );
};
