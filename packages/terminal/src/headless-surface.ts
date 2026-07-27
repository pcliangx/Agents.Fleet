// RT-MOD-08 / RT-TERM-02 — headless Terminal Surface: wraps @xterm/headless.
// No DOM, no renderer. This is the deterministic parser/buffer core that both
// the WebGL2 and DOM draw paths share (RT-TERM-03/05), and what the Daemon's
// Snapshot Worker will replay chunks through. xterm.js never leaks past this
// class's public methods (RT-MOD-09); feed/appliedCursor/cursorPosition/
// renderText live on the shared base.

import { SerializeAddon } from "@xterm/addon-serialize";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";
import * as HeadlessModule from "@xterm/headless";
import {
  BaseTerminalSurface,
  configureUnicode11,
  type TerminalSurfaceOptions,
} from "./base-terminal-surface.js";

// xterm.js EscapeSequenceParser state value for GROUND (no escape / CSI / OSC /
// DCS in progress). Empirically 0 on @xterm/headless 6.0.0 (mid-CSI == 4,
// mid-OSC == 8); named so the safe-checkpoint read is self-explanatory.
const PARSER_GROUND = 0;

// @xterm/headless 6.0.0 is CommonJS: native Node ESM exposes Terminal on the
// default export, while Vite/Vitest also synthesize the named export. Resolve
// both shapes so the Daemon's real child process and bundled tests use the
// same pinned package.
const Terminal =
  (
    HeadlessModule as unknown as {
      readonly Terminal?: typeof HeadlessTerminal;
      readonly default?: { readonly Terminal: typeof HeadlessTerminal };
    }
  ).Terminal ??
  (
    HeadlessModule as unknown as {
      readonly default: { readonly Terminal: typeof HeadlessTerminal };
    }
  ).default.Terminal;

// RT-TERM-12 — the only xterm.js internals needed to prove a Snapshot safe
// checkpoint: the parser's current state and the UTF-8 decoder's interim bytes.
// Reached via the `_core` escape hatch on the pinned package set; a stable
// public-API patch is the RT-TERM-13 exit condition (see
// docs/probes/r0-08-snapshot-checkpoint.md).
interface XtermCheckpointInternals {
  readonly _core: {
    readonly _inputHandler: {
      readonly _parser: { readonly currentState: number };
      readonly _utf8Decoder: { readonly interim: ReadonlyArray<number> };
      readonly _windowTitle: string;
    };
  };
}

const internals = (term: unknown): XtermCheckpointInternals["_core"]["_inputHandler"] =>
  (term as unknown as XtermCheckpointInternals)._core._inputHandler;

export class HeadlessTerminalSurface extends BaseTerminalSurface {
  private readonly headlessTerm: HeadlessTerminal;

  constructor(opts: TerminalSurfaceOptions) {
    // xterm 6 gates the `buffer` namespace behind allowProposedApi. Reading the
    // grid/cursor (base) and the Snapshot Worker's addon-serialize both need
    // buffer access; there is no stable v6 alternative for cell reads.
    const term = new Terminal({ cols: opts.cols, rows: opts.rows, allowProposedApi: true });
    configureUnicode11(term);
    super(term, opts.maxPendingWriteBytes ?? Number.POSITIVE_INFINITY);
    this.headlessTerm = term;
  }

  /** RT-TERM-12 / RT-ORDER-08 — parserGround && utf8DecoderEmpty at the last write. */
  isSnapshotSafeCheckpoint(): boolean {
    const ih = internals(this.term);
    // interim[0] holds the pending UTF-8 lead (>= 0xC0) when a multibyte code
    // point straddles the write boundary; 0 means no pending bytes. (Defensive:
    // a stray continuation byte in slot 0 would also read != 0 and be treated
    // as unsafe, never silently as a safe checkpoint.)
    const utf8DecoderEmpty = ih._utf8Decoder.interim[0] === 0;
    return ih._parser.currentState === PARSER_GROUND && utf8DecoderEmpty;
  }

  /** RT-T-22 — the OSC 0/2 window title, for Snapshot+delta title consistency. */
  getTitle(): string {
    return internals(this.term)._windowTitle;
  }

  /** RT-TERM-07/11 — ANSI serialization wrapped by Agents.Fleet's Snapshot schema. */
  serializeText(): string {
    const addon = new SerializeAddon();
    this.headlessTerm.loadAddon(addon);
    try {
      return addon.serialize();
    } finally {
      addon.dispose();
    }
  }
}
