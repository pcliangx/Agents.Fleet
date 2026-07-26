// RT-DIST-08 — frozen R0 SupportedPlatformMatrix (matrixVersion 3).
//
// This is the canonical, versioned platform matrix. Concrete values are frozen
// here (not in the spec schema) and referenced by matrixVersion across the
// handshake, capability proof, daemon config and release manifest. Per
// RT-DIST-08, any change to a constrained field produces a new matrixVersion and
// re-runs the affected fixtures; old results do not carry forward.
//
// Field provenance is recorded in evidenceRefs and in
// docs/probes/r0-15-supported-platform-matrix.md.
//
// History: v1 = R0-15 initial freeze (#14); v2 = R0-16 froze
// runtimeLimitProfileVersion at 1 (#15); v3 = #57 Electron 34.5.8 → 43.2.0
// (EOL → supported line; fuse wire gained WasmTrapHandlers at index 8).
//
// Pending fields (kept at 0 until their owning slice lands; a change there bumps
// this matrix to a new version per RT-DIST-08):
//   - signingAndNotarizationPolicyVersion: R5 distribution

import type { SupportedPlatformMatrix } from "./platform.js";

export const FROZEN_PLATFORM_MATRIX: SupportedPlatformMatrix = {
  matrixVersion: 3,
  architecture: "arm64",
  minimumMacOSVersion: "26",
  minimumHardware: {
    // MacBookAir10,1 = M1 MacBook Air (Nov 2020), the lowest-config Apple
    // Silicon Mac; base 8 GiB. Perf budgets (RT-PERF-08) freeze against this.
    machineModel: "MacBookAir10,1",
    cpuClass: "M1",
    gpuClass: "apple-integrated",
    memoryBytes: 8589934592,
  },
  electronVersion: "43.2.0",
  nodeRuntimeVersion: "22.17.1",
  nodePtyArtifactIdentity: "node-pty@1.1.0;darwin-arm64",
  // Canonical, sorted package@version set (packages/terminal dependencies).
  // SHA-256 022372a2f5eb69f9afa11f0e6f0b8cfe193a6683d6b29cb0cca433a48a8b4546 —
  // recorded in docs/probes/r0-15/evidence.json.
  terminalPackageSetIdentity:
    "@xterm/addon-serialize@0.14.0,@xterm/addon-unicode11@0.9.0,@xterm/addon-webgl@0.19.0,@xterm/headless@6.0.0,@xterm/xterm@6.0.0",
  // R0-16 RuntimeLimitProfile freeze (issue #15) — version 1.
  runtimeLimitProfileVersion: 1,
  rendererPaths: ["WebGL2", "DOM"],
  // R0-12 Keychain capability-proof scheme (issue #11) — version 1.
  keychainPolicyVersion: 1,
  signingAndNotarizationPolicyVersion: 0,
  evidenceRefs: [
    "RT-DIST-08",
    "RT-DIST-09",
    "PLATFORM-1",
    "RT-T-45",
    "docs/probes/r0-10-node-pty-isolation.md",
    "docs/probes/r0-15-supported-platform-matrix.md",
    "docs/probes/r0-16-runtime-limit-profile.md",
  ],
};

export const PLATFORM_MATRIX_VERSION: number = FROZEN_PLATFORM_MATRIX.matrixVersion;
