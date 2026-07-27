// R0-14 — InputIntentStore（Seam 3，RT-STO-11、RT-INPUT-01..04、RT-T-24）。
// 原始 bytes 的 content object 先完成与 chunk 相同的文件 durability 协议
// （临时文件 → checksum → 文件 fsync → 原子 rename → 目录 fsync），再在
// SQLite transaction 中创建引用该 checksum / identity 的 Prepared record；
// 此前绝不调用 PTY write（RT-STO-11、RT-INPUT-01）。PTY owner 接受 bytes 后
// 追加 Dispatched（RT-INPUT-02）。Prepared 与 Dispatched 之间崩溃由
// Reconciliation 标 Uncertain，绝不自动重放（RT-INPUT-03）；同 commandId
// 已有 Dispatched 时返回原结果，不重复写 PTY（RT-INPUT-04）。

import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { InputSource, PtySink } from "@agents-fleet/contracts";
import { DataIntegrityFailure } from "./byte-journal.js";
import {
  type ContentObjectStep,
  durableWriteContentObject,
  type QuarantinedFile,
  quarantineFile,
  sha256Hex,
  verifyContentObject,
} from "./content-object-io.js";
import { withTx } from "./store-schema.js";

/** RT-T-24 边界：文件协议四步 + Prepared commit + PTY write + Dispatched commit。 */
export type InputIntentStep =
  | ContentObjectStep
  | "afterPreparedTx"
  | "afterPtyWrite"
  | "afterDispatchedTx";

export interface DispatchCommand {
  readonly commandId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly attachmentId: string;
  readonly fencingToken: number;
  readonly source: InputSource;
  readonly bytes: Uint8Array;
}

export type DispatchResult =
  | { readonly status: "Dispatched"; readonly inputIntentId: string; readonly byteLength: number }
  | { readonly status: "Uncertain"; readonly inputIntentId: string }
  | { readonly status: "DataGap"; readonly inputIntentId: string; readonly reason: string }
  | { readonly status: "IdempotencyConflict"; readonly commandId: string };

interface IntentRow {
  readonly input_intent_id: string;
  readonly session_id: string;
  readonly generation: number;
  readonly attachment_id: string;
  readonly fencing_token: number;
  readonly source: InputSource;
  readonly content_ref: string;
  readonly sha256: string;
  readonly byte_length: number;
  readonly status: string;
  readonly data_gap: number;
}

export const contentObjectRelativePath = (commandId: string): string =>
  join("input-intents", `${sha256Hex(Buffer.from(commandId, "utf8"))}.bin`);

export class InputIntentStore {
  private readonly storeDir: string;
  private readonly db: DatabaseSync;
  private readonly ptySink: Pick<PtySink, "write">;
  private readonly now: () => number;
  private readonly onStep: ((step: InputIntentStep, commandId: string) => void) | undefined;

  constructor(opts: {
    readonly storeDir: string;
    readonly db: DatabaseSync;
    readonly ptySink: Pick<PtySink, "write">;
    readonly now?: () => number;
    /** 崩溃注入 seam（RT-T-24）：在每个协议边界同步回调。 */
    readonly onStep?: (step: InputIntentStep, commandId: string) => void;
  }) {
    this.storeDir = opts.storeDir;
    this.db = opts.db;
    this.ptySink = opts.ptySink;
    this.now = opts.now ?? Date.now;
    this.onStep = opts.onStep;
  }

  readonly dispatch = async (cmd: DispatchCommand): Promise<DispatchResult> => {
    const sha256 = sha256Hex(cmd.bytes);
    const existing = this.intentRow(cmd.commandId);
    if (existing) {
      if (
        existing.sha256 !== sha256 ||
        existing.session_id !== cmd.sessionId ||
        existing.generation !== cmd.generation ||
        existing.source !== cmd.source
      ) {
        return { status: "IdempotencyConflict", commandId: cmd.commandId };
      }
      // 已有 record：绝不重放 bytes。结果只能是原成功 / Uncertain / 明确失败。
      const verification = verifyContentObject(
        join(this.storeDir, existing.content_ref),
        existing.sha256,
      );
      if (existing.data_gap === 1 || !verification.ok) {
        return {
          status: "DataGap",
          inputIntentId: existing.input_intent_id,
          reason: "content-object-missing-or-corrupt",
        };
      }
      if (existing.status === "Dispatched") {
        // RT-INPUT-04：返回原结果，不再写 PTY。
        return {
          status: "Dispatched",
          inputIntentId: existing.input_intent_id,
          byteLength: existing.byte_length,
        };
      }
      // Prepared（含崩溃残留）或 Uncertain：PTY write 是否发生无法确认（RT-INPUT-03）。
      return { status: "Uncertain", inputIntentId: existing.input_intent_id };
    }

    // 新命令：content object 先 durable（RT-STO-11），此前绝不写 PTY。
    const written = durableWriteContentObject({
      storeDir: this.storeDir,
      relativeDir: "input-intents",
      finalName: basename(contentObjectRelativePath(cmd.commandId)),
      bytes: cmd.bytes,
      onStep: (step) => this.onStep?.(step, cmd.commandId),
    });

    const inputIntentId = `ii-${sha256Hex(Buffer.from(cmd.commandId, "utf8")).slice(0, 32)}`;
    withTx(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO input_intents
             (input_intent_id, command_id, session_id, generation, attachment_id,
              fencing_token, source, content_ref, sha256, byte_length, redacted_preview,
              status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Prepared', ?)`,
        )
        .run(
          inputIntentId,
          cmd.commandId,
          cmd.sessionId,
          cmd.generation,
          cmd.attachmentId,
          cmd.fencingToken,
          cmd.source,
          written.relativePath,
          written.sha256,
          written.byteLength,
          `[input ${written.byteLength} bytes]`,
          new Date(this.now()).toISOString(),
        );
    });
    this.onStep?.("afterPreparedTx", cmd.commandId);

    // Prepared record 已 durable，才把 bytes 交给 PTY owner（RT-INPUT-01）。
    await this.ptySink.write(cmd.bytes);
    this.onStep?.("afterPtyWrite", cmd.commandId);

    // RT-INPUT-02：PTY owner 接受后持久化 Dispatched，然后才返回成功。
    withTx(this.db, () => {
      this.db
        .prepare(
          "UPDATE input_intents SET status = 'Dispatched', dispatched_at = ? WHERE input_intent_id = ?",
        )
        .run(new Date(this.now()).toISOString(), inputIntentId);
    });
    this.onStep?.("afterDispatchedTx", cmd.commandId);

    return { status: "Dispatched", inputIntentId, byteLength: written.byteLength };
  };

  /** RT-INPUT-01：恢复源是 content object；缺失 / 损坏显式失败，不用派生数据替代。 */
  readonly readContent = (commandId: string): Uint8Array => {
    const row = this.intentRow(commandId);
    if (!row) throw new DataIntegrityFailure(`no Input Intent record for ${commandId}`);
    const verification = verifyContentObject(join(this.storeDir, row.content_ref), row.sha256);
    if (!verification.ok) {
      throw new DataIntegrityFailure(
        `Input Intent content ${verification.reason} for ${commandId}`,
      );
    }
    return new Uint8Array(verification.bytes);
  };

  private readonly intentRow = (commandId: string): IntentRow | undefined =>
    this.db
      .prepare(
        `SELECT input_intent_id, session_id, generation, attachment_id, fencing_token,
                source, content_ref, sha256, byte_length, status, data_gap
         FROM input_intents
         WHERE command_id = ?`,
      )
      .get(commandId) as IntentRow | undefined;
}

export interface InputIntentReconciliationReport {
  /** Prepared 残留被标 Uncertain 的 commandId（RT-INPUT-03）。 */
  readonly markedUncertain: readonly string[];
  /** record 在而 object 缺失 / checksum 失败的 commandId（RT-STO-11 的 dataGap）。 */
  readonly dataGaps: readonly string[];
  /** 无 record 的 orphan content object（含临时残骸），隔离到 quarantine。 */
  readonly isolatedOrphans: readonly QuarantinedFile[];
}

/**
 * RT-INPUT-03 / RT-STO-11 的对账：Prepared（非 Dispatched）一律标 Uncertain
 * —— 从幸存 record 无法判定 PTY write 是否发生，绝不自动重放；
 * object 缺失 / 损坏标 dataGap；无 record 的 object 隔离回收。
 */
export const reconcileInputIntents = (
  storeDir: string,
  db: DatabaseSync,
): InputIntentReconciliationReport => {
  const markedUncertain: string[] = [];
  const dataGaps: string[] = [];
  const isolatedOrphans: QuarantinedFile[] = [];

  const rows = db
    .prepare(
      "SELECT input_intent_id, command_id, content_ref, sha256, status, data_gap FROM input_intents ORDER BY command_id",
    )
    .all() as unknown as (IntentRow & { readonly command_id: string })[];

  for (const row of rows) {
    const intact = verifyContentObject(join(storeDir, row.content_ref), row.sha256).ok;
    withTx(db, () => {
      if (!intact && row.data_gap !== 1) {
        db.prepare("UPDATE input_intents SET data_gap = 1 WHERE input_intent_id = ?").run(
          row.input_intent_id,
        );
      }
      if (row.status === "Prepared") {
        db.prepare("UPDATE input_intents SET status = 'Uncertain' WHERE input_intent_id = ?").run(
          row.input_intent_id,
        );
      }
    });
    if (!intact) dataGaps.push(row.command_id);
    if (row.status === "Prepared") markedUncertain.push(row.command_id);
  }

  // 无 record 的 object（含 rename 前崩溃留下的临时文件）：隔离，绝不重放。
  const intentsDir = join(storeDir, "input-intents");
  if (existsSync(intentsDir)) {
    for (const file of readdirSync(intentsDir)) {
      const isTemp = file.startsWith(".tmp-");
      const hasRecord =
        !isTemp &&
        db
          .prepare("SELECT 1 AS x FROM input_intents WHERE content_ref = ?")
          .get(join("input-intents", file)) !== undefined;
      if (hasRecord) continue;
      isolatedOrphans.push(
        quarantineFile({
          storeDir,
          relativeDir: "input-intents",
          fileName: file,
          quarantineName: `input-intent-${file.replace(/^\.tmp-/, "tmp-")}`,
        }),
      );
    }
  }

  return { markedUncertain, dataGaps, isolatedOrphans };
};
