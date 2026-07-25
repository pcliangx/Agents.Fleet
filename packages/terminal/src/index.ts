// @agents-fleet/terminal — Terminal Surface Module (RT-MOD-08).
// Owns the xterm.js instance, allowed official addons, and the Terminal Surface
// Interface that hides xterm.js types from business UI and tests (RT-MOD-09).
// Expanded slice by slice: S1 locks the package set; S3 adds the headless
// engine; S4 the renderer (DOM) surface and engine-identity proof.

export * from "./allowlist.js";
export {
  BaseTerminalSurface,
  configureUnicode11,
  TerminalPendingWriteLimitError,
  TerminalSeqGapError,
  type TerminalSurfaceOptions,
} from "./base-terminal-surface.js";
export { HeadlessTerminalSurface } from "./headless-surface.js";
export { XtermTerminalSurface } from "./xterm-surface.js";
