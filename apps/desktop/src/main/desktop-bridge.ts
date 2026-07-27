// RT-MOD-10 / SV1-ELECTRON-06 — Electron Main's typed Desktop Bridge.
//
// Renderer values enter through command-specific methods. Main validates and
// constructs the closed daemon envelope; there is no generic invoke or
// renderer-controlled CommandKind.

import { randomUUID } from "node:crypto";
import type {
  AttachResult,
  ControlLease,
  FleetProjectionView,
  InputIntent,
  InputSource,
} from "@agents-fleet/contracts";
import { FROZEN_RUNTIME_LIMIT_PROFILE } from "@agents-fleet/contracts";
import type { CommandResponse, OutgoingCommand } from "./daemon-client.js";
import { isCommandError } from "./daemon-client.js";

export interface DesktopBridgeSender {
  sendCommand(command: OutgoingCommand): Promise<CommandResponse>;
}

export interface DesktopBridgeError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly commandId?: string | undefined;
}

export type DesktopBridgeResult<T> =
  | { readonly ok: true; readonly result: T }
  | { readonly ok: false; readonly error: DesktopBridgeError };

export interface CreatedTask {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly lifecycle: "Draft";
  readonly taskSpecVersion: number;
  readonly stateVersion: number;
}

interface ValidatedTaskSpec {
  readonly goal: string;
  readonly context?: string;
  readonly constraints?: string;
  readonly acceptanceCriteria?: string;
}

const recordOf = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

type ValidationFailure = { readonly ok: false; readonly error: DesktopBridgeError };

const invalid = (message: string): ValidationFailure => ({
  ok: false,
  error: { code: "InvalidRequest", message, retryable: false },
});

const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

const positiveInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;

const INPUT_SOURCES: readonly InputSource[] = ["Keyboard", "IME", "Paste", "Mouse", "Automation"];

const validateLease = (
  value: unknown,
): { readonly ok: true; readonly lease: ControlLease } | ValidationFailure => {
  const lease = recordOf(value);
  if (
    lease === null ||
    !nonempty(lease.sessionId) ||
    !positiveInteger(lease.generation) ||
    !nonempty(lease.attachmentId) ||
    !positiveInteger(lease.fencingToken) ||
    typeof lease.expiresAt !== "number"
  ) {
    return invalid("lease must contain valid session, generation, attachment and fencing identity");
  }
  return { ok: true, lease: lease as unknown as ControlLease };
};

const validateTaskSpec = (
  value: unknown,
): { readonly ok: true; readonly spec: ValidatedTaskSpec } | ValidationFailure => {
  const spec = recordOf(value);
  if (spec === null) return invalid("spec must be an object");
  const allowed = new Set(["goal", "context", "constraints", "acceptanceCriteria"]);
  for (const key of Object.keys(spec)) {
    if (!allowed.has(key)) return invalid(`spec has unknown field: ${key}`);
  }
  if (!nonempty(spec.goal)) return invalid("spec.goal must be a non-empty string");
  for (const key of ["context", "constraints", "acceptanceCriteria"] as const) {
    if (spec[key] !== undefined && typeof spec[key] !== "string") {
      return invalid(`spec.${key} must be a string`);
    }
  }
  return {
    ok: true,
    spec: {
      goal: spec.goal,
      ...(typeof spec.context === "string" ? { context: spec.context } : {}),
      ...(typeof spec.constraints === "string" ? { constraints: spec.constraints } : {}),
      ...(typeof spec.acceptanceCriteria === "string"
        ? { acceptanceCriteria: spec.acceptanceCriteria }
        : {}),
    },
  };
};

const transportFailure = (error: unknown): DesktopBridgeError => ({
  code: "InternalFailure",
  message: `daemon command failed: ${(error as Error).message}`,
  retryable: false,
});

export class DesktopBridgeCore {
  readonly #sender: DesktopBridgeSender;

  constructor(options: { readonly sender: DesktopBridgeSender }) {
    this.#sender = options.sender;
  }

  async #send<T>(
    kind: string,
    payload: Record<string, unknown>,
    identities: Omit<OutgoingCommand, "commandId" | "schemaVersion" | "payload"> = {},
  ): Promise<DesktopBridgeResult<T>> {
    let response: CommandResponse;
    try {
      response = await this.#sender.sendCommand({
        commandId: randomUUID(),
        schemaVersion: 1,
        ...identities,
        payload: { kind, ...payload },
      });
    } catch (error) {
      return { ok: false, error: transportFailure(error) };
    }
    if (isCommandError(response)) {
      return {
        ok: false,
        error: {
          code: response.error.code,
          message: response.error.message,
          retryable: response.error.retryable,
          commandId: response.error.commandId,
        },
      };
    }
    return { ok: true, result: response.result as T };
  }

  async createTask(input: unknown): Promise<DesktopBridgeResult<CreatedTask>> {
    const request = recordOf(input);
    if (request === null || !nonempty(request.workspaceId)) {
      return invalid("workspaceId must be a non-empty string");
    }
    const validated = validateTaskSpec(request.spec);
    if (!validated.ok) return validated;
    return await this.#send<CreatedTask>(
      "CreateTask",
      { spec: validated.spec },
      { workspaceId: request.workspaceId },
    );
  }

  async getFleetProjection(
    workspaceId: unknown,
  ): Promise<DesktopBridgeResult<FleetProjectionView>> {
    if (!nonempty(workspaceId)) {
      return invalid("workspaceId must be a non-empty string");
    }
    return await this.#send<FleetProjectionView>("GetFleetProjection", {}, { workspaceId });
  }

  async attachTerminal(input: unknown): Promise<DesktopBridgeResult<AttachResult>> {
    const request = recordOf(input);
    if (request === null || !nonempty(request.sessionId)) {
      return invalid("sessionId must be a non-empty string");
    }
    if (
      request.fromSeq !== undefined &&
      (!Number.isSafeInteger(request.fromSeq) || (request.fromSeq as number) < 1)
    ) {
      return invalid("fromSeq must be a positive integer");
    }
    const attached = await this.#send<AttachResult>("Attach", {
      sessionId: request.sessionId,
      fromSeq: request.fromSeq,
    });
    if (!attached.ok) return attached;
    const snapshotBytes = attached.result.snapshot.bytes;
    const normalizedBytes =
      snapshotBytes instanceof Uint8Array
        ? Uint8Array.from(snapshotBytes)
        : Array.isArray(snapshotBytes)
          ? Uint8Array.from(snapshotBytes)
          : null;
    if (normalizedBytes === null) {
      return invalid("daemon returned an invalid terminal Snapshot");
    }
    return {
      ok: true,
      result: {
        ...attached.result,
        snapshot: { ...attached.result.snapshot, bytes: normalizedBytes },
      },
    };
  }

  async acquireControl(attachmentId: unknown): Promise<DesktopBridgeResult<ControlLease>> {
    if (!nonempty(attachmentId)) {
      return invalid("attachmentId must be a non-empty string");
    }
    return await this.#send<ControlLease>("AcquireControl", {}, { attachmentId });
  }

  async writeTerminalInput(input: unknown): Promise<DesktopBridgeResult<InputIntent>> {
    const request = recordOf(input);
    if (request === null) return invalid("input must be an object");
    const validated = validateLease(request.lease);
    if (!validated.ok) return validated;
    if (
      typeof request.source !== "string" ||
      !(INPUT_SOURCES as readonly string[]).includes(request.source)
    ) {
      return invalid("source is invalid");
    }
    if (!(request.bytes instanceof Uint8Array)) {
      return invalid("bytes must be a Uint8Array");
    }
    if (request.bytes.byteLength > FROZEN_RUNTIME_LIMIT_PROFILE.inputIntentBytes) {
      return invalid("terminal input exceeds the runtime limit");
    }
    const lease = validated.lease;
    return await this.#send<InputIntent>(
      "WriteSessionInput",
      {
        bytes: Array.from(request.bytes),
        source: request.source,
      },
      {
        sessionId: lease.sessionId,
        expectedGeneration: lease.generation,
        attachmentId: lease.attachmentId,
        fencingToken: lease.fencingToken,
      },
    );
  }

  async resizeTerminal(input: unknown): Promise<DesktopBridgeResult<{ readonly resized: true }>> {
    const request = recordOf(input);
    if (request === null) return invalid("resize request must be an object");
    const validated = validateLease(request.lease);
    if (!validated.ok) return validated;
    if (!positiveInteger(request.cols) || !positiveInteger(request.rows)) {
      return invalid("cols and rows must be positive integers");
    }
    const lease = validated.lease;
    return await this.#send(
      "ResizeSession",
      { cols: request.cols, rows: request.rows },
      {
        sessionId: lease.sessionId,
        expectedGeneration: lease.generation,
        attachmentId: lease.attachmentId,
        fencingToken: lease.fencingToken,
      },
    );
  }

  async renewControl(leaseValue: unknown): Promise<DesktopBridgeResult<ControlLease>> {
    const validated = validateLease(leaseValue);
    if (!validated.ok) return validated;
    const lease = validated.lease;
    return await this.#send<ControlLease>(
      "RenewControl",
      {},
      {
        sessionId: lease.sessionId,
        expectedGeneration: lease.generation,
        attachmentId: lease.attachmentId,
        fencingToken: lease.fencingToken,
      },
    );
  }

  async closeAttachment(
    attachmentId: unknown,
  ): Promise<DesktopBridgeResult<{ readonly closed: true }>> {
    if (!nonempty(attachmentId)) {
      return invalid("attachmentId must be a non-empty string");
    }
    return await this.#send("CloseAttachment", {}, { attachmentId });
  }
}
