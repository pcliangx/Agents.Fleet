// RT-LIMIT — RuntimeLimitProfile TYPE ONLY. Values frozen in
// ./frozen-runtime-limit-profile.ts (issue #15 / R0-16).
// Transcribed from runtime-contracts-v1.md §2.1.

export interface TerminalLimits {
  readonly scrollbackLines: number;
  readonly glyphs: number;
  readonly imagePlaceholderBytes: number;
  readonly webglTextureBytes: number;
  readonly domNodes: number;
  readonly pendingWriteBytes: number;
  readonly pendingInputBytes: number;
  readonly paintQueueItems: number;
  readonly effectPayloadBytes: number;
  readonly effectsPerSecond: number;
}

export interface RuntimeLimitProfile {
  readonly profileVersion: number;
  readonly controlLineBytes: number;
  readonly commandPayloadBytes: number;
  readonly streamHeaderBytes: number;
  readonly streamFramePayloadBytes: number;
  readonly streamFramesPerSecond: number;
  readonly attachmentQueueBytes: number;
  readonly attachmentQueueFrames: number;
  readonly inputIntentBytes: number;
  readonly taskFieldBytes: number;
  readonly taskSpecBytes: number;
  readonly profileBytes: number;
  readonly pathBytes: number;
  readonly adapterObservationBytes: number;
  readonly adapterObservationsPerSecond: number;
  readonly challengeBytes: number;
  readonly artifactMetadataBytes: number;
  readonly artifactContentStreamChunkBytes: number;
  readonly notificationPayloadBytes: number;
  readonly snapshotBytes: number;
  readonly fileTreeEntries: number;
  readonly diffBytes: number;
  readonly fingerprintFiles: number;
  readonly fingerprintBytes: number;
  readonly fingerprintDurationMs: number;
  readonly controlRequestsPerSecond: number;
  readonly rendererMemoryBytes: number;
  readonly snapshotWorkerMemoryBytes: number;
  readonly terminal: TerminalLimits;
}
