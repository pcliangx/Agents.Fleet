import { describe, expect, it } from "vitest";
import { evaluateExternalUrl } from "../main/external-url.js";

// SV1-ELECTRON-03 / SV1-TERM-03 — external URLs may only leave via https,
// an explicit user gesture, and (when configured) a host allowlist.

describe("external URL policy", () => {
  it("allows an allowlisted https URL with a user gesture", () => {
    expect(
      evaluateExternalUrl(
        { url: "https://example.com/docs", userGesture: true },
        { allowedHosts: ["example.com"] },
      ),
    ).toMatchObject({ allowed: true });
  });

  it.each([
    [{ url: "https://example.com/", userGesture: false }, "missing user gesture"],
    [{ url: "http://example.com/", userGesture: true }, "only https"],
    [{ url: "file:///etc/passwd", userGesture: true }, "only https"],
    [{ url: "javascript:alert(1)", userGesture: true }, "only https"],
    [{ url: "data:text/html,<script>1</script>", userGesture: true }, "only https"],
    [{ url: "af-app://app/index.html", userGesture: true }, "only https"],
    [{ url: "https://user:pw@example.com/", userGesture: true }, "userinfo"],
    [{ url: "not a url", userGesture: true }, "unparseable"],
  ])("refuses %o", (request, reasonFragment) => {
    const decision = evaluateExternalUrl(request, { allowedHosts: ["example.com"] });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toContain(reasonFragment);
  });

  it("refuses a non-allowlisted host even with a gesture", () => {
    const decision = evaluateExternalUrl(
      { url: "https://evil.example/", userGesture: true },
      { allowedHosts: ["example.com"] },
    );
    expect(decision).toMatchObject({ allowed: false, reason: "host not in allowlist" });
  });
});
