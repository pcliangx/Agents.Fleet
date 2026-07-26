import { readFileSync } from "node:fs";
import { type NotificationDeliveryPolicy, NotificationGateway } from "../notification-gateway.js";
import { openNotificationDb } from "../notification-outbox.js";
import { NotificationActivationSigner } from "../notification-security.js";
import { PersistentFakeNotificationCenter } from "../persistent-fake-notification-center.js";

interface ChildConfig {
  readonly lifecycleDbPath: string;
  readonly centerDbPath: string;
  readonly policy: NotificationDeliveryPolicy;
  readonly nowMs: number;
}

const configPath = process.argv[2];
if (configPath === undefined) throw new Error("missing child config path");
const config = JSON.parse(readFileSync(configPath, "utf8")) as ChildConfig;
const db = openNotificationDb(config.lifecycleDbPath);
const center = new PersistentFakeNotificationCenter(config.centerDbPath, {
  crashAfterWrite: true,
});
const activationSigner = new NotificationActivationSigner(Buffer.alloc(32, 0x13));
const gateway = new NotificationGateway({
  db,
  center,
  policy: config.policy,
  activationSigner,
});

await gateway.dispatchDue(config.nowMs);
db.close();
throw new Error("armed crash did not fire");
