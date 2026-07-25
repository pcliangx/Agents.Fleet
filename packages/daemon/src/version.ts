// PLACEHOLDER daemon constants. protocol/matrix/profile version values are
// frozen in #15/#16; do not consume as canonical until then.

import type { DaemonId, Generation } from "@agents-fleet/contracts";
import {
  PLACEHOLDER_PLATFORM_MATRIX_VERSION,
  PLACEHOLDER_RUNTIME_LIMIT_PROFILE_VERSION,
  PROTOCOL_VERSIONS,
} from "@agents-fleet/contracts";

export const DAEMON_ID = "agents-fleet-daemon" as DaemonId;
export const DAEMON_GENERATION = 1 as Generation;
export const DAEMON_PROTOCOL_VERSIONS: readonly number[] = PROTOCOL_VERSIONS;
export const DAEMON_PLATFORM_MATRIX_VERSION = PLACEHOLDER_PLATFORM_MATRIX_VERSION;
export const DAEMON_RUNTIME_LIMIT_PROFILE_VERSION = PLACEHOLDER_RUNTIME_LIMIT_PROFILE_VERSION;
