import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROBE_POLICY, runNotificationGatewayProbe } from "./driver.js";

const here = dirname(fileURLToPath(import.meta.url));
const evidenceDir = join(here, "..", "..", "..", "..", "..", "docs", "probes", "r0-13");
const outputPath = join(evidenceDir, "evidence.json");

const result = await runNotificationGatewayProbe();
const evidence = {
  probe: "r0-13-notification-gateway",
  contracts: [
    "RT-MOD-11",
    "RT-NOTIFY-01",
    "RT-NOTIFY-02",
    "RT-NOTIFY-03",
    "RT-NOTIFY-04",
    "RT-NOTIFY-05",
    "RT-NOTIFY-06",
    "RT-T-28",
    "SV1-DATA-09",
    "SV1-T-23",
  ],
  capturedAt: new Date().toISOString(),
  platform: {
    macOS: execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim(),
    kernel: execFileSync("uname", ["-s", "-r", "-m"], { encoding: "utf8" }).trim(),
  },
  node: process.version,
  sqlite: "node:sqlite (WAL + synchronous=FULL)",
  policyFixture: {
    normative: false,
    note: "Probe-only values; RuntimeLimitProfile is owned by R0-15.",
    ...PROBE_POLICY,
  },
  ...result,
};

if (!evidence.allChecksPass) {
  throw new Error(`R0-13 probe failed: ${JSON.stringify(evidence.checks)}`);
}

mkdirSync(evidenceDir, { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
process.stdout.write(`R0-13 PASS (${Object.keys(evidence.checks).length} checks)\n`);
process.stdout.write(`evidence written: ${outputPath}\n`);
