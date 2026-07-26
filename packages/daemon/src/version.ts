// Daemon version constants. PLATFORM_MATRIX_VERSION is frozen (RT-DIST-08,
// issue #14 / R0-15). RUNTIME_LIMIT_PROFILE_VERSION stays a placeholder until
// R0-16 (issue #15) — do not consume it as canonical until then.

import type { DaemonId, Generation } from "@agents-fleet/contracts";
import {
  PLACEHOLDER_RUNTIME_LIMIT_PROFILE_VERSION,
  PLATFORM_MATRIX_VERSION,
  PROTOCOL_VERSIONS,
} from "@agents-fleet/contracts";

export const DAEMON_ID = "agents-fleet-daemon" as DaemonId;
export const DAEMON_GENERATION = 1 as Generation;
export const DAEMON_PROTOCOL_VERSIONS: readonly number[] = PROTOCOL_VERSIONS;
export const DAEMON_PLATFORM_MATRIX_VERSION = PLATFORM_MATRIX_VERSION;
export const DAEMON_RUNTIME_LIMIT_PROFILE_VERSION = PLACEHOLDER_RUNTIME_LIMIT_PROFILE_VERSION;
