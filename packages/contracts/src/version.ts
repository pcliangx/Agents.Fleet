// Protocol + matrix/profile versions.
// PLATFORM_MATRIX_VERSION is frozen in ./frozen-platform-matrix.ts (RT-DIST-08,
// issue #14 / R0-15). RUNTIME_LIMIT_PROFILE_VERSION is frozen in
// ./frozen-runtime-limit-profile.ts (RT-LIMIT-01, issue #15 / R0-16).

export { PLATFORM_MATRIX_VERSION } from "./frozen-platform-matrix.js";
export { RUNTIME_LIMIT_PROFILE_VERSION } from "./frozen-runtime-limit-profile.js";

export const PROTOCOL_VERSIONS = [1] as const;
