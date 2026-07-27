// SV1-FILE-06/07/10/11 — shared restricted Git process policy.
//
// Provision, inspection, Ready verification and disposal must not drift into
// subtly different environment/config neutralization. Callers may add stricter
// per-operation overrides, but this baseline is always present.

import { tmpdir } from "node:os";
import { FROZEN_RUNTIME_LIMIT_PROFILE } from "@agents-fleet/contracts";

export const RESTRICTED_GIT_CONFIG_OVERRIDES: readonly string[] = [
  "core.hooksPath=/dev/null",
  "core.fsmonitor=false",
  "core.pager=cat",
  "diff.external=",
  "credential.helper=",
  "submodule.recurse=false",
];

export const buildRestrictedGitEnvironment = (
  options: { readonly neutralizeSystemAttributes?: boolean } = {},
): Record<string, string> => ({
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  LANG: "en_US.UTF-8",
  TMPDIR: process.env.TMPDIR ?? tmpdir(),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_GLOBAL: "/dev/null",
  ...(options.neutralizeSystemAttributes === true ? { GIT_ATTR_NOSYSTEM: "1" } : {}),
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
  PAGER: "cat",
  GIT_EDITOR: "/usr/bin/true",
  EDITOR: "/usr/bin/true",
});

// The frozen v1 local-Git observation duration is also the fail-closed bound
// for each restricted inspect / verify / dispose invocation. Provision has a
// separately probed materialization timeout owned by its R0 implementation.
export const RESTRICTED_GIT_OPERATION_TIMEOUT_MS =
  FROZEN_RUNTIME_LIMIT_PROFILE.fingerprintDurationMs;
