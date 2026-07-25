// node-pty-free PTY abstraction. Implemented by FakePty (testing) now and by a
// node-pty-backed ProcessSupervisor in #9/#10. Lives in contracts so testing
// and daemon share it without a dependency cycle.

export interface PtySink {
  /** Resolves once the PTY owner has accepted the bytes (not once the child consumed them). */
  write(bytes: Uint8Array): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  kill(): Promise<void>;
  /** Subscribe to output bytes; returns an unsubscribe. */
  onOutput(cb: (bytes: Uint8Array) => void): () => void;
}
