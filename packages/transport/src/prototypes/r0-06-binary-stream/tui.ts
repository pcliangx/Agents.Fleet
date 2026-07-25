// PROTOTYPE — interactive shell for the R0-06 pure backpressure model.

import type { Generation, Seq, SessionId, StreamFrameHeader } from "@agents-fleet/contracts";
import {
  type AttachmentFlowState,
  consumeQueuedFrames,
  createAttachmentFlowState,
  ingestDurableFrame,
  resyncAtDurableHead,
  setAttachmentHidden,
  summarizeAttachmentFlow,
} from "./model.js";

const sessionId = "r0-06-interactive" as SessionId;
const generation = 1 as Generation;
const payloadBytes = 64 * 1024;
let state: AttachmentFlowState = createAttachmentFlowState(sessionId, generation, {
  bytes: 256 * 1024,
  frames: 8,
});

const ingest = (count: number): void => {
  for (let index = 0; index < count; index += 1) {
    const nextSeq = ((state.durableSeq as number) + 1) as Seq;
    const header: StreamFrameHeader = {
      frameType: "output",
      sessionId,
      generation,
      seq: nextSeq,
      payloadLength: payloadBytes,
    };
    state = ingestDurableFrame(state, {
      header,
      payloadBytes,
      wireBytes: payloadBytes + 128,
    });
  }
};

const render = (): void => {
  console.clear();
  process.stdout.write("\u001b[1mR0-06 PROTOTYPE — Attachment backpressure\u001b[0m\n");
  process.stdout.write(
    "\u001b[2mDurable input continues; a bounded live queue must resync explicitly when continuity is lost.\u001b[0m\n\n",
  );
  process.stdout.write(`${JSON.stringify(summarizeAttachmentFlow(state), null, 2)}\n\n`);
  process.stdout.write(
    "\u001b[1m[1]\u001b[0m ingest 1  \u001b[1m[b]\u001b[0m burst 8  \u001b[1m[c]\u001b[0m consume 1\n",
  );
  process.stdout.write(
    "\u001b[1m[h]\u001b[0m toggle hidden  \u001b[1m[r]\u001b[0m Snapshot resync  \u001b[1m[q]\u001b[0m quit\n",
  );
};

if (!process.stdin.isTTY) throw new Error("R0-06 prototype requires an interactive terminal");
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");
render();

process.stdin.on("data", (keys: string) => {
  for (const key of keys) {
    if (key === "q" || key === "\u0003") {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      return;
    }
    if (key === "1") ingest(1);
    if (key === "b") ingest(8);
    if (key === "c") state = consumeQueuedFrames(state, payloadBytes + 128).state;
    if (key === "h") state = setAttachmentHidden(state, !state.hidden);
    if (key === "r") state = resyncAtDurableHead(state);
  }
  render();
});
