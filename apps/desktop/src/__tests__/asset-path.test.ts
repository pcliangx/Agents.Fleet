import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AssetPathPolicy, resolveAssetPath } from "../main/asset-path.js";

// SV1-ELECTRON-01 / SV1-T-16 — the app protocol resolver must only ever
// return real files inside the installed renderer asset root.

describe("af-app asset path resolution", () => {
  let root: string;
  let realRoot: string;
  let tempDir: string;
  let policy: AssetPathPolicy;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "af-asset-path-"));
    root = join(tempDir, "renderer");
    await writeFile(join(tempDir, "secret.txt"), "top-secret");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(root, "subdir"), { recursive: true });
    realRoot = await realpath(root);
    await writeFile(join(root, "index.html"), "<html></html>");
    await writeFile(join(root, "app.js"), "void 0;");
    await symlink("../secret.txt", join(root, "linked-secret.txt"));
    await symlink("app.js", join(root, "linked-app.js"));
    policy = { scheme: "af-app", host: "app", assetRoot: root };
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it.each([
    ["af-app://app/index.html", "index.html"],
    ["af-app://app/", "index.html"],
    ["af-app://app/app.js", "app.js"],
  ])("serves %s", async (url, file) => {
    const resolution = await resolveAssetPath(policy, url);
    expect(resolution).toEqual({ ok: true, absolutePath: `${realRoot}/${file}` });
  });

  it("allows a symlink that stays inside the asset root", async () => {
    const resolution = await resolveAssetPath(policy, "af-app://app/linked-app.js");
    expect(resolution).toEqual({ ok: true, absolutePath: `${realRoot}/app.js` });
  });

  it.each([
    "af-app://app/../secret.txt",
    "af-app://app/subdir/../../secret.txt",
    "af-app://app/%2e%2e/secret.txt",
    "af-app://app/%2E%2E%2fsecret.txt",
    "af-app://app/linked-secret.txt",
    "af-app://app//etc/passwd",
    "af-app://app/%5csecret.txt",
    "af-app://app/index.html%00.png",
    "af-app://app/%zz",
    "af-app://evil.example/index.html",
    "af-app://app:8443/index.html",
    "af-app://user@app/index.html",
    "https://app/index.html",
    "file:///etc/passwd",
    "not a url",
  ])("denies %s", async (url) => {
    const resolution = await resolveAssetPath(policy, url);
    expect(resolution.ok).toBe(false);
  });

  it("reports a missing in-root asset as not found (never a network fallback)", async () => {
    const resolution = await resolveAssetPath(policy, "af-app://app/no-such.js");
    expect(resolution).toEqual({ ok: false, reason: "asset not found" });
  });
});
