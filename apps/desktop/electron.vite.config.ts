import { resolve } from "node:path";
import { defineConfig } from "electron-vite";

// Workspace packages resolve from source (packages/*/package.json main →
// ./src/index.ts, no pre-build — same convention as vitest.workspace.ts).
// electron-vite externalizes a package's `dependencies` by default, which
// would leave @agents-fleet/* as runtime requires and make the Electron main
// process load raw TypeScript — so they are explicitly excluded from
// externalization and bundled instead (electron and Node built-ins stay
// external by default).
export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: ["@agents-fleet/contracts", "@agents-fleet/transport"] },
      rollupOptions: { input: { index: resolve(__dirname, "src/main/index.ts") } },
    },
  },
  preload: {
    build: {
      externalizeDeps: { exclude: ["@agents-fleet/contracts", "@agents-fleet/transport"] },
      rollupOptions: { input: { index: resolve(__dirname, "src/preload/index.ts") } },
    },
  },
  renderer: {
    root: "src/renderer",
    build: { rollupOptions: { input: { index: resolve(__dirname, "src/renderer/index.html") } } },
  },
});
