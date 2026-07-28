// SV1-AUTH-06/08 / SV1-ELECTRON-06 — the typed Renderer capability surface.
// Command-named methods only: no generic send/invoke, no channel passthrough,
// no Node objects. Every method forwards to the matching Main IPC channel;
// the Renderer never touches the daemon socket (SV1-AUTH-05), never sees the
// capability token and can only NAME an existing challenge ID for the native
// confirmation (SV1-AUTH-10) — receipt signing happens in Main.

import type {
  AttachResult,
  ControlLease,
  FleetProjectionView,
  InputIntent,
} from "@agents-fleet/contracts";
import type { ConfirmationIpcResult, TrustCommandIpcResult } from "../main/confirmation-ipc.js";
import type {
  CreatedTask,
  DesktopBridgeError,
  DesktopBridgeResult,
} from "../main/desktop-bridge.js";

/** Display-only fields of the RT-REPO-06 trust challenge request. The daemon
 *  binds candidate identity + user identity + the frozen validation plan; the
 *  rest is dialog text (SV1-TRUST-02). */
export interface TrustChallengeRequestInput {
  readonly candidate: {
    readonly canonicalRoot: string;
    readonly filesystemIdentity: { readonly dev: number; readonly ino: number };
  };
  readonly userIdentity: string;
  readonly plannedAgent: string;
  readonly dataLocation: string;
  readonly hostPermissionUpperBound: string;
}

export interface DesktopApi {
  getConnectionInfo(): Promise<string>;
  createTask(input: {
    readonly workspaceId: string;
    readonly spec: {
      readonly goal: string;
      readonly context?: string;
      readonly constraints?: string;
      readonly acceptanceCriteria?: string;
    };
  }): Promise<DesktopBridgeResult<CreatedTask>>;
  getFleetProjection(workspaceId: string): Promise<DesktopBridgeResult<FleetProjectionView>>;
  attachTerminal(input: {
    readonly sessionId: string;
    readonly fromSeq?: number;
  }): Promise<TerminalAttachmentResult>;
  acquireTerminalControl(attachmentId: string): Promise<DesktopBridgeResult<ControlLease>>;
  writeTerminalInput(input: {
    readonly lease: ControlLease;
    readonly source: "Keyboard" | "IME" | "Paste" | "Mouse" | "Automation";
    readonly bytes: Uint8Array;
  }): Promise<DesktopBridgeResult<InputIntent>>;
  resizeTerminal(input: {
    readonly lease: ControlLease;
    readonly cols: number;
    readonly rows: number;
  }): Promise<DesktopBridgeResult<{ readonly resized: true }>>;
  closeTerminal(attachmentId: string): Promise<DesktopBridgeResult<{ readonly closed: true }>>;
  /** RT-REPO-01 — canonicalize a candidate path (no Git, no Trust row). */
  prepareTrustCandidate(path: string): Promise<TrustCommandIpcResult>;
  /** RT-REPO-06 — issue the one-time Repository Trust challenge. */
  issueTrustChallenge(request: TrustChallengeRequestInput): Promise<TrustCommandIpcResult>;
  /** SV1-ELECTRON-07 — ask Main to open the native confirmation for an
   *  already-issued challenge ID. Display text can never be supplied here. */
  requestConfirmation(challengeId: string): Promise<ConfirmationIpcResult>;
  /** RT-REPO-02/03 — run the restricted validation plan; success activates
   *  the Trust and creates the Workspace in one transaction. */
  validateAndActivateTrust(trustId: string): Promise<TrustCommandIpcResult>;
  /** RT-REPO-05 / SV1-TRUST-05 — user revoke; stop-or-keep is required when
   *  non-terminal Attempts exist. */
  revokeTrust(
    trustId: string,
    runningProcessChoice?: "stop" | "keep",
  ): Promise<TrustCommandIpcResult>;
  /** RT-REPO-04 — Active-only declared read-only inspection. */
  inspectRepository(workspaceId: string): Promise<TrustCommandIpcResult>;
}

export interface RendererMessagePort {
  postMessage(message: unknown): void;
  close(): void;
  onMessage(listener: (message: unknown) => void): () => void;
}

export type TerminalAttachmentResult =
  | { readonly ok: true; readonly result: AttachResult; readonly port: RendererMessagePort }
  | { readonly ok: false; readonly error: DesktopBridgeError };

type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>;
type ReceiveTerminalPort = (attachmentId: string) => Promise<RendererMessagePort>;

export const createDesktopApi = (
  invoke: Invoke,
  receiveTerminalPort: ReceiveTerminalPort = async () => {
    throw new Error("terminal MessagePort receiver is unavailable");
  },
): DesktopApi => ({
  getConnectionInfo: () => invoke("af:get-connection-info") as Promise<string>,
  createTask: (input) =>
    invoke("af:create-task", input) as Promise<DesktopBridgeResult<CreatedTask>>,
  getFleetProjection: (workspaceId) =>
    invoke("af:get-fleet-projection", workspaceId) as Promise<
      DesktopBridgeResult<FleetProjectionView>
    >,
  attachTerminal: async (input) => {
    const attached = (await invoke(
      "af:attach-terminal",
      input,
    )) as DesktopBridgeResult<AttachResult>;
    if (!attached.ok) return attached;
    return {
      ...attached,
      port: await receiveTerminalPort(attached.result.attachmentId),
    };
  },
  acquireTerminalControl: (attachmentId) =>
    invoke("af:acquire-terminal-control", attachmentId) as Promise<
      DesktopBridgeResult<ControlLease>
    >,
  writeTerminalInput: (input) =>
    invoke("af:write-terminal-input", input) as Promise<DesktopBridgeResult<InputIntent>>,
  resizeTerminal: (input) =>
    invoke("af:resize-terminal", input) as Promise<DesktopBridgeResult<{ readonly resized: true }>>,
  closeTerminal: (attachmentId) =>
    invoke("af:close-terminal", attachmentId) as Promise<
      DesktopBridgeResult<{ readonly closed: true }>
    >,
  prepareTrustCandidate: (path) =>
    invoke("af:prepare-trust-candidate", path) as Promise<TrustCommandIpcResult>,
  issueTrustChallenge: (request) =>
    invoke("af:issue-trust-challenge", request) as Promise<TrustCommandIpcResult>,
  requestConfirmation: (challengeId) =>
    invoke("af:request-confirmation", challengeId) as Promise<ConfirmationIpcResult>,
  validateAndActivateTrust: (trustId) =>
    invoke("af:validate-and-activate-trust", trustId) as Promise<TrustCommandIpcResult>,
  revokeTrust: (trustId, runningProcessChoice) =>
    invoke("af:revoke-trust", trustId, runningProcessChoice) as Promise<TrustCommandIpcResult>,
  inspectRepository: (workspaceId) =>
    invoke("af:inspect-repository", workspaceId) as Promise<TrustCommandIpcResult>,
});
