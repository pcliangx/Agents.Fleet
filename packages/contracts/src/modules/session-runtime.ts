// RT-MOD-03 — Session Runtime public seam.
//
// ProcessSupervisor, ByteJournal, chunk paths, SQLite and PTY types are
// intentionally absent (RT-MOD-13).

import type { SessionAvailability } from "../lifecycle/session.js";
import type { PreparedLaunch } from "./task-orchestrator.js";

export type LaunchSessionResult =
  | {
      readonly kind: "running";
      readonly attemptId: string;
      readonly sessionId: string;
      readonly generation: number;
    }
  | { readonly kind: "failed"; readonly attemptId: string; readonly reason: string }
  | { readonly kind: "uncertain"; readonly attemptId: string; readonly reason: string };

export interface LaunchValidation {
  readonly revalidate: () => Promise<boolean>;
}

export interface DurableFrameRef {
  readonly sessionId: string;
  readonly generation: number;
  readonly seq: number;
}

export interface SessionRuntimeRecord {
  readonly sessionId: string;
  readonly attemptId: string;
  readonly generation: number;
  readonly availability: SessionAvailability;
}

export type RestartReconciliationAction =
  | {
      readonly action: "marked-lost";
      readonly attemptId: string;
      readonly sessionId: string;
    }
  | {
      readonly action: "resume-prepared";
      readonly attemptId: string;
      readonly launchNonce: string;
      readonly preparedLaunch: PreparedLaunch;
    }
  | {
      readonly action: "aborted-before-commit";
      readonly attemptId: string;
      readonly launchNonce: string;
    }
  | {
      readonly action: "marked-uncertain";
      readonly attemptId: string;
      readonly launchNonce: string;
    }
  | {
      readonly action: "aborted-bootstrap-lost";
      readonly attemptId: string;
      readonly launchNonce: string;
    };

export interface RestartReconciliationReport {
  readonly actions: readonly RestartReconciliationAction[];
  readonly dataIntegrity: {
    readonly adoptedOrphanCount: number;
    readonly isolatedOrphanCount: number;
    readonly dataGapCount: number;
    readonly verifiedChunks: number;
  };
}

export interface SessionRuntime {
  launch(prepared: PreparedLaunch, validation: LaunchValidation): Promise<LaunchSessionResult>;
  terminate(sessionId: string): Promise<void>;
  inspectSession(sessionId: string): SessionRuntimeRecord | null;
  readDurableFrame(frame: DurableFrameRef): Uint8Array | null;
  reconcileAfterRestart(): RestartReconciliationReport;
}
