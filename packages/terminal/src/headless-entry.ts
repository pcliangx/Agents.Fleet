// Daemon-only headless entry. Deliberately excludes XtermTerminalSurface so a
// Node process never evaluates the browser renderer or @xterm/xterm package.

export { TERMINAL_PACKAGE_SET } from "./allowlist.js";
export { HeadlessTerminalSurface } from "./headless-surface.js";
