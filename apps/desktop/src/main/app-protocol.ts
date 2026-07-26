// SV1-ELECTRON-01 — restricted private app protocol `af-app`.
// Release builds load the renderer exclusively through this scheme (never
// file://). The handler only serves real files under the installed renderer
// asset root (see asset-path.ts); every other request is denied, and a miss
// is a 404 — there is deliberately no network fallback (SV1-TERM-02).

import { stat } from "node:fs/promises";
import { extname } from "node:path";
import { pathToFileURL } from "node:url";
import { net, protocol } from "electron";
import { resolveAssetPath } from "./asset-path.js";

export const APP_SCHEME = "af-app";
export const APP_HOST = "app";
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/**
 * Must be called before `app.whenReady()` (module scope of the Main entry).
 * `standard` + `secure` make Chromium treat the scheme like https for origin,
 * CSP and fetch purposes.
 */
export const registerAppSchemePrivileges = (): void => {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
      },
    },
  ]);
};

export interface AppProtocolOptions {
  readonly assetRoot: string;
  /** CSP header attached to every served response (SV1-ELECTRON-04). */
  readonly contentSecurityPolicy: string;
}

/**
 * Serve renderer assets for `af-app://<APP_HOST>/...` from `assetRoot` only.
 * Install after `app.whenReady()`.
 */
export const installAppProtocol = (options: AppProtocolOptions): void => {
  const policy = { scheme: APP_SCHEME, host: APP_HOST, assetRoot: options.assetRoot };
  protocol.handle(APP_SCHEME, async (request) => {
    const resolution = await resolveAssetPath(policy, request.url);
    if (!resolution.ok) {
      // Fail closed: traversal/host/symlink attacks are 403, misses are 404.
      // No remote URL is ever consulted here.
      const status = resolution.reason === "asset not found" ? 404 : 403;
      return new Response(`af-app: ${resolution.reason}`, { status });
    }
    const fileStat = await stat(resolution.absolutePath);
    if (!fileStat.isFile()) {
      return new Response("af-app: not a regular file", { status: 403 });
    }
    const headers = new Headers({
      "Content-Type": MIME_TYPES[extname(resolution.absolutePath)] ?? "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": options.contentSecurityPolicy,
    });
    const fileResponse = await net.fetch(pathToFileURL(resolution.absolutePath).toString());
    return new Response(fileResponse.body, { status: 200, headers });
  });
};
