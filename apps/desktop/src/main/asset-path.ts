// SV1-ELECTRON-01 — pure path resolution for the private app protocol.
// Kept free of Electron imports so the resolver is unit-testable under vitest.
// The resolver only ever returns real paths inside the installed renderer
// asset root: no arbitrary local paths, no traversal, no symlink escape, and
// no network fallback of any kind (a miss is a 404, never a remote fetch).

import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export type AssetResolution =
  | { readonly ok: true; readonly absolutePath: string }
  | { readonly ok: false; readonly reason: string };

const deny = (reason: string): AssetResolution => ({ ok: false, reason });

export interface AssetPathPolicy {
  readonly scheme: string;
  readonly host: string;
  readonly assetRoot: string;
}

/**
 * Resolve a request URL to a real file inside `assetRoot`, or deny it.
 * Denies: wrong scheme/host, invalid percent-encoding, NUL, backslash, `..`
 * segments, paths escaping the root, symlinks escaping the root, and anything
 * that does not exist as a real file under the root.
 */
export const resolveAssetPath = async (
  policy: AssetPathPolicy,
  requestUrl: string,
): Promise<AssetResolution> => {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return deny("unparseable URL");
  }
  if (url.protocol !== `${policy.scheme}:`) return deny("unexpected scheme");
  if (url.host !== policy.host) return deny("unexpected host");
  if (url.port !== "") return deny("unexpected port");
  if (url.username !== "" || url.password !== "") return deny("unexpected userinfo");

  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return deny("invalid percent-encoding");
  }
  if (pathname.includes("\0")) return deny("NUL byte in path");
  if (pathname.includes("\\")) return deny("backslash in path");

  const rawPath = pathname === "/" ? "/index.html" : pathname;
  // Reject traversal segments outright, before any normalization.
  if (rawPath.split("/").some((segment) => segment === "..")) {
    return deny("directory traversal segment");
  }

  const candidate = resolve(policy.assetRoot, `.${rawPath}`);
  const relativeToRoot = relative(policy.assetRoot, candidate);
  if (relativeToRoot === "" || relativeToRoot.startsWith("..") || isAbsolute(relativeToRoot)) {
    return deny("path escapes asset root");
  }

  // Resolve symlinks on both sides; a symlinked asset must still land inside
  // the real asset root (SV1-ELECTRON-01: no arbitrary local paths).
  let realRoot: string;
  let realCandidate: string;
  try {
    realRoot = await realpath(policy.assetRoot);
    realCandidate = await realpath(candidate);
  } catch {
    return deny("asset not found");
  }
  const realRelative = relative(realRoot, realCandidate);
  if (realRelative === "" || realRelative.startsWith("..") || isAbsolute(realRelative)) {
    return deny("symlink escapes asset root");
  }

  return { ok: true, absolutePath: realCandidate };
};
