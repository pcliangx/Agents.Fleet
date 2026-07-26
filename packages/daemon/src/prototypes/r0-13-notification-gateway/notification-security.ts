import { createHmac, timingSafeEqual } from "node:crypto";
import {
  type NotificationRoute,
  parseNotificationRoute,
  STABLE_ID,
} from "./notification-outbox.js";

export interface ActivationIdentity {
  readonly notificationIntentId: string;
  readonly route: NotificationRoute;
}

const MAX_ACTIVATION_BYTES = 2_048;

const activationError = (): Error => new Error("invalid notification activation envelope");

const copySecret = (secret: Uint8Array): Buffer => {
  if (secret.byteLength < 32) throw new Error("activation secret must contain at least 32 bytes");
  return Buffer.from(secret);
};

const signatureFor = (secret: Buffer, payloadSegment: string): Buffer =>
  createHmac("sha256", secret).update(payloadSegment, "utf8").digest();

const canonicalIdentity = (input: ActivationIdentity): ActivationIdentity => {
  if (!STABLE_ID.test(input.notificationIntentId)) throw activationError();
  return {
    notificationIntentId: input.notificationIntentId,
    route: parseNotificationRoute(input.route),
  };
};

export class NotificationActivationSigner {
  readonly #secret: Buffer;

  constructor(secret: Uint8Array) {
    this.#secret = copySecret(secret);
  }

  sign(input: ActivationIdentity): string {
    const identity = canonicalIdentity(input);
    const payloadSegment = Buffer.from(
      JSON.stringify({
        version: 1,
        notificationIntentId: identity.notificationIntentId,
        route: identity.route,
      }),
      "utf8",
    ).toString("base64url");
    const signature = signatureFor(this.#secret, payloadSegment).toString("base64url");
    return `${payloadSegment}.${signature}`;
  }
}

export class NotificationActivationAuthenticator {
  readonly #secret: Buffer;

  constructor(secret: Uint8Array) {
    this.#secret = copySecret(secret);
  }

  authenticate(token: string): ActivationIdentity {
    try {
      if (Buffer.byteLength(token, "utf8") > MAX_ACTIVATION_BYTES) throw activationError();
      const segments = token.split(".");
      if (segments.length !== 2) throw activationError();
      const payloadSegment = segments[0];
      const signatureSegment = segments[1];
      if (payloadSegment === undefined || signatureSegment === undefined) throw activationError();
      const suppliedSignature = Buffer.from(signatureSegment, "base64url");
      const expectedSignature = signatureFor(this.#secret, payloadSegment);
      if (
        suppliedSignature.byteLength !== expectedSignature.byteLength ||
        !timingSafeEqual(suppliedSignature, expectedSignature)
      ) {
        throw activationError();
      }

      const decoded = Buffer.from(payloadSegment, "base64url").toString("utf8");
      const value = JSON.parse(decoded) as unknown;
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw activationError();
      }
      const candidate = value as Record<string, unknown>;
      const keys = Object.keys(candidate).sort();
      if (
        keys.length !== 3 ||
        keys[0] !== "notificationIntentId" ||
        keys[1] !== "route" ||
        keys[2] !== "version" ||
        candidate.version !== 1 ||
        typeof candidate.notificationIntentId !== "string"
      ) {
        throw activationError();
      }
      return canonicalIdentity({
        notificationIntentId: candidate.notificationIntentId,
        route: parseNotificationRoute(candidate.route),
      });
    } catch {
      throw activationError();
    }
  }
}
