import { defineWorkspace } from "vitest/config";

// Each package tests its own src. Packages resolve from source (exports → ./src),
// so no pre-build is required for vitest or tsc.
export default defineWorkspace([
  { test: { name: "contracts", include: ["packages/contracts/src/**/*.test.ts"] } },
  { test: { name: "transport", include: ["packages/transport/src/**/*.test.ts"] } },
  { test: { name: "testing", include: ["packages/testing/src/**/*.test.ts"] } },
  { test: { name: "daemon", include: ["packages/daemon/src/**/*.test.ts"] } },
  { test: { name: "desktop", include: ["apps/desktop/src/**/*.test.ts"] } },
]);
