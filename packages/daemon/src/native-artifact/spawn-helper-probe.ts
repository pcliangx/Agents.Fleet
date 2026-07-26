// RT-DIST-01 / SV1-SUPPLY-02 — real Node probe for the spawn-helper sampler.
//
// Separated from spawn-helper-sampler.ts so the sampler stays pure and
// Node-free (R0-15 platform-gate pattern). Not imported by production source;
// the Daemon install/upgrade path (R5) will wire this where the verifier runs.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { SpawnHelperProbeDeps } from "./spawn-helper-sampler.js";

/** Real probe: stat for mode, file/vtool/codesign via spawnSync (codesign writes stderr), sha256 via crypto. */
export const defaultProbeDeps: SpawnHelperProbeDeps = {
  mode(path) {
    try {
      return statSync(path).mode & 0o777;
    } catch {
      return null;
    }
  },
  runText(command, args) {
    const result = spawnSync(command, [...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  },
  sha256(path) {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  },
};
