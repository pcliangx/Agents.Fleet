// SV1-ELECTRON-05 — Electron fuse wire reader and release-posture verifier.
//
// The fuse wire is embedded in the Electron Framework binary (macOS:
// `Electron Framework.framework/Versions/Current/Electron Framework`) as:
//   sentinel "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX"
//   1 byte  fuse wire version (currently 1)
//   1 byte  fuse wire length (9 — one ASCII '0'/'1' flag per fuse, Electron 43+)
//   N bytes flags in FuseKey order
// (Format confirmed empirically against Electron 43.2.0: wire "101100011",
// matching Electron's shipped defaults; Electron 34.5.8 carried 8 fuses —
// wire "10110001" — before WasmTrapHandlers was appended at index 8.)
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
  "WasmTrapHandlers",
] as const;

export type FuseKey = (typeof FUSE_KEYS)[number];

/**
 * Required release posture (SV1-ELECTRON-05): no RunAsNode, no
 * NODE_OPTIONS / CLI-inspect injection, asar integrity + app-only-from-asar
 * on, no browser-process V8 snapshot from outside the bundle, no extra
 * file:// privileges. EnableCookieEncryption goes beyond the contract minimum
 * but is required by our release policy (protects cookies at rest).
 * WasmTrapHandlers stays at Electron's default (on): it only selects V8's
 * WebAssembly OOB-check mechanism (signal handler vs explicit bounds checks)
 * and is not a code-execution / privilege surface.
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
  WasmTrapHandlers: true,
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
