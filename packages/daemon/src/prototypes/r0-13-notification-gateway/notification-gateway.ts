import type { DatabaseSync } from "node:sqlite";
import {
  type NotificationIntent,
  type NotificationRoute,
  parseNotificationRoute,
  readNotificationSnapshot,
  withTransaction,
} from "./notification-outbox.js";
import type { ActivationIdentity, NotificationActivationSigner } from "./notification-security.js";

export interface SystemNotification {
  readonly notificationId: string;
  readonly title: string;
  readonly body: string;
  readonly activationData: string;
}

export type SystemNotificationResult =
  | { readonly status: "Delivered" }
  | { readonly status: "Failed"; readonly errorCode: string };

export interface SystemNotificationCenter {
  deliver(notification: SystemNotification): Promise<SystemNotificationResult>;
}

export interface NotificationDeliveryPolicy {
  readonly maxAttempts: number;
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
  readonly notificationPayloadBytes: number;
}

export interface NotificationGatewayOptions {
  readonly db: DatabaseSync;
  readonly center: SystemNotificationCenter;
  readonly policy: NotificationDeliveryPolicy;
  readonly activationSigner: NotificationActivationSigner;
}

export interface DispatchOutcome {
  readonly notificationIntentId: string;
  readonly outcome: "Delivered" | "RetryScheduled" | "Failed";
  readonly deliveryNumber: number;
}

interface PersistedActivationRow {
  readonly route_json: string;
  readonly delivery_state: string;
}

const notificationContent = (
  intent: NotificationIntent,
): Pick<SystemNotification, "title" | "body"> => {
  if (intent.contentClass === "AttemptCompleted") {
    return {
      title: "Agent task completed",
      body: "An attempt finished successfully.",
    };
  }
  return {
    title: "Agent task needs attention",
    body: "Open Agents Fleet to review an attempt.",
  };
};

const toSystemNotification = (
  intent: NotificationIntent,
  activationSigner: NotificationActivationSigner,
): SystemNotification => ({
  notificationId: intent.notificationIntentId,
  ...notificationContent(intent),
  activationData: activationSigner.sign({
    notificationIntentId: intent.notificationIntentId,
    route: intent.route,
  }),
});

const safeErrorCode = (error: unknown): string => {
  if (error instanceof Error && error.name === "AbortError") return "CENTER_ABORTED";
  return "CENTER_EXCEPTION";
};

const ALLOWED_CENTER_ERROR_CODES = new Set([
  "CENTER_ABORTED",
  "CENTER_DENIED",
  "CENTER_EXCEPTION",
  "CENTER_UNAVAILABLE",
]);

const normalizeCenterErrorCode = (errorCode: string): string =>
  ALLOWED_CENTER_ERROR_CODES.has(errorCode) ? errorCode : "CENTER_ERROR";

export class NotificationGateway {
  readonly #db: DatabaseSync;
  readonly #center: SystemNotificationCenter;
  readonly #policy: NotificationDeliveryPolicy;
  readonly #activationSigner: NotificationActivationSigner;

  constructor(options: NotificationGatewayOptions) {
    if (
      !Number.isSafeInteger(options.policy.maxAttempts) ||
      options.policy.maxAttempts < 1 ||
      !Number.isSafeInteger(options.policy.retryBaseMs) ||
      options.policy.retryBaseMs < 1 ||
      !Number.isSafeInteger(options.policy.retryMaxMs) ||
      options.policy.retryMaxMs < options.policy.retryBaseMs ||
      !Number.isSafeInteger(options.policy.notificationPayloadBytes) ||
      options.policy.notificationPayloadBytes < 1
    ) {
      throw new Error("invalid notification delivery policy");
    }
    this.#db = options.db;
    this.#center = options.center;
    this.#policy = options.policy;
    this.#activationSigner = options.activationSigner;
  }

  async dispatchDue(nowMs: number): Promise<DispatchOutcome[]> {
    const due = readNotificationSnapshot(this.#db).notificationIntents.filter(
      (intent) => intent.deliveryState === "Pending" && intent.nextDeliveryAtMs <= nowMs,
    );
    const outcomes: DispatchOutcome[] = [];

    for (const intent of due) {
      const notification = toSystemNotification(intent, this.#activationSigner);
      if (
        Buffer.byteLength(JSON.stringify(notification), "utf8") >
        this.#policy.notificationPayloadBytes
      ) {
        outcomes.push(this.#recordFailure(intent, nowMs, "PAYLOAD_LIMIT_EXCEEDED"));
        continue;
      }

      let result: SystemNotificationResult;
      try {
        result = await this.#center.deliver(notification);
      } catch (error) {
        result = { status: "Failed", errorCode: safeErrorCode(error) };
      }

      if (result.status === "Delivered") {
        outcomes.push(this.#recordDelivered(intent, nowMs));
      } else {
        outcomes.push(
          this.#recordFailure(intent, nowMs, normalizeCenterErrorCode(result.errorCode)),
        );
      }
    }

    return outcomes;
  }

  acknowledgeAuthenticatedActivation(activation: ActivationIdentity): NotificationRoute {
    const row = this.#db
      .prepare(
        `SELECT route_json, delivery_state
         FROM notification_intents
         WHERE notification_intent_id = ?`,
      )
      .get(activation.notificationIntentId) as PersistedActivationRow | undefined;
    if (row === undefined) throw new Error("notification activation binding was not found");
    const persistedRoute = parseNotificationRoute(JSON.parse(row.route_json) as unknown);
    if (JSON.stringify(persistedRoute) !== JSON.stringify(activation.route)) {
      throw new Error("notification activation binding does not match");
    }
    if (row.delivery_state !== "Delivered" && row.delivery_state !== "Acknowledged") {
      throw new Error("notification activation binding is not delivered");
    }
    this.#db
      .prepare(
        `UPDATE notification_intents
         SET delivery_state = 'Acknowledged'
         WHERE notification_intent_id = ? AND delivery_state = 'Delivered'`,
      )
      .run(activation.notificationIntentId);
    return persistedRoute;
  }

  #recordDelivered(intent: NotificationIntent, nowMs: number): DispatchOutcome {
    const deliveryNumber = intent.deliveryCount + 1;
    return withTransaction(this.#db, () => {
      this.#db
        .prepare(
          `UPDATE notification_intents
           SET delivery_state = 'Delivered', delivery_count = ?, last_error_code = NULL
           WHERE notification_intent_id = ? AND delivery_state = 'Pending'`,
        )
        .run(deliveryNumber, intent.notificationIntentId);
      this.#insertObservation(
        intent.notificationIntentId,
        deliveryNumber,
        "Delivered",
        null,
        nowMs,
      );
      return {
        notificationIntentId: intent.notificationIntentId,
        outcome: "Delivered",
        deliveryNumber,
      };
    });
  }

  #recordFailure(intent: NotificationIntent, nowMs: number, errorCode: string): DispatchOutcome {
    const deliveryNumber = intent.deliveryCount + 1;
    const exhausted = deliveryNumber >= this.#policy.maxAttempts;
    const outcome = exhausted ? "Failed" : "RetryScheduled";
    const delayMs = Math.min(
      this.#policy.retryBaseMs * 2 ** (deliveryNumber - 1),
      this.#policy.retryMaxMs,
    );

    return withTransaction(this.#db, () => {
      this.#db
        .prepare(
          `UPDATE notification_intents
           SET delivery_state = ?, delivery_count = ?, next_delivery_at_ms = ?,
               last_error_code = ?
           WHERE notification_intent_id = ? AND delivery_state = 'Pending'`,
        )
        .run(
          exhausted ? "Failed" : "Pending",
          deliveryNumber,
          nowMs + delayMs,
          errorCode,
          intent.notificationIntentId,
        );
      this.#insertObservation(
        intent.notificationIntentId,
        deliveryNumber,
        outcome,
        errorCode,
        nowMs,
      );
      return {
        notificationIntentId: intent.notificationIntentId,
        outcome,
        deliveryNumber,
      };
    });
  }

  #insertObservation(
    notificationIntentId: string,
    deliveryNumber: number,
    outcome: DispatchOutcome["outcome"],
    errorCode: string | null,
    observedAtMs: number,
  ): void {
    this.#db
      .prepare(
        `INSERT INTO notification_delivery_observations (
           notification_intent_id, delivery_number, outcome, error_code, observed_at_ms
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(notificationIntentId, deliveryNumber, outcome, errorCode, observedAtMs);
  }
}
