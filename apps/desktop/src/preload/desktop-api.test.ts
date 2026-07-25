import { describe, expect, it } from "vitest";
import { createDesktopApi } from "./desktop-api.js";

describe("Desktop preload capability boundary", () => {
  it("exposes no PTY, socket, native object, or generic IPC capability", () => {
    const api = createDesktopApi(async () => "connected");

    expect(Object.keys(api)).toEqual(["getConnectionInfo"]);
  });
});
