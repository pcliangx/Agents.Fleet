// RT-LIMIT-01 — frozen R0 RuntimeLimitProfile (profileVersion 1).
//
// This is the canonical, versioned runtime limit profile. Concrete values are
// frozen here (not in the spec schema) and referenced by profileVersion across
// the handshake, Daemon / Main / Renderer / worker boundary checks, and the
// release manifest. Per RT-LIMIT-03, any change to a limit produces a new
// profileVersion and re-runs the affected boundary / exhaustion / recovery /
// performance fixtures; old results do not carry forward.
//
// Field provenance (details in docs/probes/r0-16-runtime-limit-profile.md):
//   spec-derived      taskFieldBytes / taskSpecBytes (RT-TASK-01),
//                     terminal.scrollbackLines (RT-PERF-03 reference load)
//   R0-06 measured    attachmentQueueBytes / attachmentQueueFrames /
//                     streamFramePayloadBytes
//   a-priori targets  everything else — engineering bounds with documented
//                     rationale, to be re-validated on the matrix floor
//                     (M1 / 8 GiB) fixture in R4. streamFramesPerSecond sits
//                     here too: 240 is the R0-06-observed 80 fps with a 3x
//                     headroom factor, i.e. measurement-derived, not measured.

import type { RuntimeLimitProfile } from "./limits.js";

export const FROZEN_RUNTIME_LIMIT_PROFILE: RuntimeLimitProfile = {
  profileVersion: 1,

  // Control channel (NDJSON): the envelope wraps the payload plus receipt /
  // confirmation fields, so the line cap sits above the payload cap.
  controlLineBytes: 2_097_152, // 2 MiB
  commandPayloadBytes: 1_048_576, // 1 MiB — ≥ taskSpecBytes: a start command carries a full Task spec

  // Stream channel (length-prefixed binary frames). R0-06 measured ~65,537
  // bytes/frame and 80 fps on the hot session under the RT-PERF-08-shaped
  // fixed load; caps freeze the frame size and allow 3× rate headroom.
  streamHeaderBytes: 4_096,
  streamFramePayloadBytes: 65_536, // 64 KiB
  streamFramesPerSecond: 240,

  // Per-attachment live queue — the exact caps the R0-06 backpressure
  // prototype proved under the fixed load (byte cap boundary at 1,048,577,
  // frame cap boundary at 33).
  attachmentQueueBytes: 1_048_576, // 1 MiB
  attachmentQueueFrames: 32,

  inputIntentBytes: 65_536, // 64 KiB — a large paste stays bounded before durable write

  // Task spec bounds — RT-TASK-01 verbatim (512 KiB per field, 1 MiB total).
  taskFieldBytes: 524_288,
  taskSpecBytes: 1_048_576,

  profileBytes: 16_384, // 16 KiB — Agent Profile holds references only, never secret values
  pathBytes: 4_096, // PATH_MAX on darwin

  adapterObservationBytes: 1_048_576, // 1 MiB — one Hook / Transcript entry stays bounded
  adapterObservationsPerSecond: 60,

  challengeBytes: 65_536, // 64 KiB — structured confirmation challenge display (RT-CMD-17/18)

  artifactMetadataBytes: 65_536,
  artifactContentStreamChunkBytes: 1_048_576, // 1 MiB streaming chunks of Artifact content

  notificationPayloadBytes: 4_096, // 4 KiB — minimal lock-screen-safe summary (SV1-DATA-09)

  snapshotBytes: 16_777_216, // 16 MiB — bounds a 10k-scrollback Session Snapshot (RT-PERF-03)

  fileTreeEntries: 50_000, // bounded Worktree file tree (OBS-2); explicit truncation beyond
  diffBytes: 8_388_608, // 8 MiB — bounded line-level diff view (OBS-2)

  // GitObservation stateFingerprint budget (RT-EVIDENCE-03): beyond any of
  // these the fingerprint is reported incomplete with a blocker — a partial
  // fingerprint is never signed off as complete.
  fingerprintFiles: 20_000,
  fingerprintBytes: 268_435_456, // 256 MiB streaming content-hash budget
  fingerprintDurationMs: 10_000,

  controlRequestsPerSecond: 60,

  rendererMemoryBytes: 2_147_483_648, // 2 GiB — RT-PERF-04 Renderer hard cap
  snapshotWorkerMemoryBytes: 1_073_741_824, // 1 GiB — headless Snapshot Worker hard cap

  terminal: {
    scrollbackLines: 10_000, // RT-PERF-03 reference load
    glyphs: 5_000_000, // scrollback × wide-line glyph bound
    imagePlaceholderBytes: 65_536, // bounded placeholder only — addon-image is not loaded (SV1-TERM-07)
    webglTextureBytes: 268_435_456, // 256 MiB GPU texture budget
    domNodes: 200_000, // DOM fallback renderer budget
    pendingWriteBytes: 4_194_304, // 4 MiB — xterm write staging, 4× the attachment queue
    pendingInputBytes: 65_536, // ≤ inputIntentBytes: staging never exceeds the durable bound
    paintQueueItems: 240, // ~4 s of 60 fps paint signals; coalescible per RT-BP-02
    effectPayloadBytes: 4_096, // bounded TerminalEffectPolicy payload (title / OSC8 / clipboard / bell)
    effectsPerSecond: 60,
  },
};

export const RUNTIME_LIMIT_PROFILE_VERSION: number = FROZEN_RUNTIME_LIMIT_PROFILE.profileVersion;
