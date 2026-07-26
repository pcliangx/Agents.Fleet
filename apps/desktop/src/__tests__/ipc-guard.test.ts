import type { WebContents, WebFrameMain } from "electron";
import { describe, expect, it } from "vitest";
import { type TrustedSenderContext, validateIpcSender } from "../main/ipc-guard.js";

// SV1-ELECTRON-02 / SV1-T-16 — subframe, navigated, destroyed and
// foreign-origin senders are refused by default.

const fakeContents = (overrides: Partial<WebContents> = {}): WebContents =>
  ({ isDestroyed: () => false, ...overrides }) as unknown as WebContents;

const fakeFrame = (url: string, top?: WebFrameMain): WebFrameMain => {
  const frame = { url } as unknown as WebFrameMain;
  (frame as { top: WebFrameMain }).top = top ?? frame;
  return frame;
};

const mainContents = fakeContents();
const context: TrustedSenderContext = {
  expectedWebContents: mainContents,
  allowedOrigin: "af-app://app",
};

describe("IPC sender validation", () => {
  it("trusts the main frame of the expected webContents at the app origin", () => {
    expect(
      validateIpcSender(mainContents, fakeFrame("af-app://app/index.html"), context),
    ).toMatchObject({ trusted: true });
  });

  it.each([
    ["missing sender", undefined, fakeFrame("af-app://app/")],
    ["missing frame", mainContents, undefined],
    ["destroyed sender", fakeContents({ isDestroyed: () => true }), fakeFrame("af-app://app/")],
    ["unexpected webContents", fakeContents(), fakeFrame("af-app://app/")],
    ["navigated frame", mainContents, fakeFrame("data:text/html,<script>alert(1)</script>")],
    ["foreign origin", mainContents, fakeFrame("https://evil.example/")],
  ])("refuses %s", (_label, sender, frame) => {
    expect(validateIpcSender(sender, frame, context)).toMatchObject({ trusted: false });
  });

  it("refuses a subframe of the trusted window", () => {
    const top = fakeFrame("af-app://app/index.html");
    const subframe = fakeFrame("af-app://app/frame.html", top);
    expect(validateIpcSender(mainContents, subframe, context)).toEqual({
      trusted: false,
      reason: "subframe sender",
    });
  });
});
