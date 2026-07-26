// Protocol + matrix/profile versions.
// PLATFORM_MATRIX_VERSION is frozen in ./frozen-platform-matrix.ts (RT-DIST-08,
// issue #14 / R0-15). RUNTIME_LIMIT_PROFILE_VERSION stays a placeholder until
// R0-16 (issue #15) freezes it — do not consume it as canonical until then.

export { PLATFORM_MATRIX_VERSION } from "./frozen-platform-matrix.js";

export const PROTOCOL_VERSIONS = [1] as const;
export const PLACEHOLDER_RUNTIME_LIMIT_PROFILE_VERSION = 0 as const;
