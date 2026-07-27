// RT-TERM-11 — isolated headless Snapshot Worker.
//
// The parent sends only verified durable frame bytes plus terminal dimensions
// and limits. No PTY fd, ProcessSupervisor, Control Lease, database, filesystem
// path, or input capability crosses this boundary.

import serializePackage from "@xterm/addon-serialize";
import unicodePackage from "@xterm/addon-unicode11";
import headlessPackage from "@xterm/headless";
import { parentPort, threadId, workerData } from "node:worker_threads";

if (parentPort === null) throw new Error("Snapshot Worker requires a parent port");

const { Terminal } = headlessPackage;
const { SerializeAddon } = serializePackage;
const { Unicode11Addon } = unicodePackage;
const terminal = new Terminal({
  cols: workerData.cols,
  rows: workerData.rows,
  scrollback: workerData.scrollbackLines,
  allowProposedApi: true,
});
terminal.loadAddon(new Unicode11Addon());
terminal.unicode.activeVersion = "11";

const inputHandler = () => terminal._core._inputHandler;
const isSafe = () =>
  inputHandler()._parser.currentState === 0 && inputHandler()._utf8Decoder.interim[0] === 0;
const serialize = () => {
  const addon = new SerializeAddon();
  terminal.loadAddon(addon);
  try {
    return addon.serialize();
  } finally {
    addon.dispose();
  }
};
const cursor = () => ({
  row: terminal.buffer.active.cursorY,
  col: terminal.buffer.active.cursorX,
});
const write = (bytes) =>
  new Promise((resolve) => {
    terminal.write(bytes, resolve);
  });

let appliedSeq = 0;
let safe = {
  coversThroughSeq: 0,
  serialized: serialize(),
  cursor: cursor(),
  title: inputHandler()._windowTitle,
};

parentPort.on("message", async (message) => {
  try {
    if (message.type === "frame") {
      if (message.seq !== appliedSeq + 1) {
        throw new Error(`Snapshot Worker seq gap: expected ${appliedSeq + 1}, got ${message.seq}`);
      }
      if (message.bytes.byteLength > workerData.maxPendingWriteBytes) {
        throw new Error("Snapshot Worker frame exceeds pending-write limit");
      }
      await write(message.bytes);
      appliedSeq = message.seq;
      if (isSafe()) {
        safe = {
          coversThroughSeq: appliedSeq,
          serialized: serialize(),
          cursor: cursor(),
          title: inputHandler()._windowTitle,
        };
      }
      parentPort.postMessage({ type: "frame-applied", seq: appliedSeq });
      return;
    }
    if (message.type === "finish") {
      parentPort.postMessage({
        type: "result",
        ...safe,
        producer: {
          kind: "SnapshotWorker",
          threadId,
          receivedPtyHandle: false,
        },
      });
      return;
    }
    throw new Error("unknown Snapshot Worker message");
  } catch (error) {
    parentPort.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : "Snapshot Worker failed",
    });
  }
});

parentPort.postMessage({ type: "ready" });
