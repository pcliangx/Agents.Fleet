// R0-14 — content object 的文件 durability 协议（RT-STO-02 / RT-STO-11 共用形状）：
// 写临时文件 → checksum → 文件 fsync → 原子 rename → 目录 fsync。
// rename 只对同目录的临时文件生效（同 volume，原子）；完成 rename 的
// 文件即「完整写入且已 fsync」，这是 Reconciliation 能接纳 orphan 的依据。

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** RT-T-23/24 的文件协议边界，供崩溃注入在每个步骤之间 SIGKILL。 */
export const CONTENT_OBJECT_STEPS = [
  "afterChecksum",
  "afterFileFsync",
  "afterRename",
  "afterDirFsync",
] as const;
export type ContentObjectStep = (typeof CONTENT_OBJECT_STEPS)[number];

export interface WrittenContentObject {
  /** 相对 storeDir 的最终路径。 */
  readonly relativePath: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

export const fsyncDir = (dir: string): void => {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

export type ContentObjectVerification =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: "file-missing" | "checksum-mismatch" };

/**
 * 读取 content object 并对期望 sha256 校验（RT-STO-03/11 的统一判定）：
 * 缺失或 checksum 失败都是显式失败原因，调用方据此抛 DataIntegrityFailure
 * 或记 dataGap——任何路径都不得用空 bytes 或旧数据伪装。
 */
export const verifyContentObject = (
  absPath: string,
  expectedSha256: string,
): ContentObjectVerification => {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(absPath);
  } catch {
    return { ok: false, reason: "file-missing" };
  }
  if (sha256Hex(bytes) !== expectedSha256) {
    return { ok: false, reason: "checksum-mismatch" };
  }
  return { ok: true, bytes };
};

export interface QuarantinedFile {
  /** 相对 storeDir 的原路径。 */
  readonly originalPath: string;
  /** 相对 storeDir 的隔离后路径。 */
  readonly quarantinePath: string;
}

/** 把 rename 前崩溃留下的残骸隔离到 quarantine/，绝不进索引（RT-STO-03/11）。 */
export const quarantineFile = (opts: {
  readonly storeDir: string;
  readonly relativeDir: string;
  readonly fileName: string;
  readonly quarantineName: string;
}): QuarantinedFile => {
  const quarantineDir = join(opts.storeDir, "quarantine");
  mkdirSync(quarantineDir, { recursive: true });
  renameSync(
    join(opts.storeDir, opts.relativeDir, opts.fileName),
    join(quarantineDir, opts.quarantineName),
  );
  return {
    originalPath: join(opts.relativeDir, opts.fileName),
    quarantinePath: join("quarantine", opts.quarantineName),
  };
};

/**
 * 把 bytes 以完整 durability 协议落到 `relativeDir/finalName`（相对 storeDir）。
 * `onStep` 在每个协议边界同步回调（崩溃注入 seam，RT-T-23/RT-T-24）。
 */
export const durableWriteContentObject = (opts: {
  readonly storeDir: string;
  readonly relativeDir: string;
  readonly finalName: string;
  readonly bytes: Uint8Array;
  readonly onStep?: (step: ContentObjectStep) => void;
}): WrittenContentObject => {
  const dir = join(opts.storeDir, opts.relativeDir);
  mkdirSync(dir, { recursive: true });

  const relativePath = join(opts.relativeDir, opts.finalName);
  const tmpPath = join(dir, `.tmp-${process.pid}-${randomUUID()}`);
  writeFileSync(tmpPath, opts.bytes);

  const sha256 = sha256Hex(opts.bytes);
  opts.onStep?.("afterChecksum");

  {
    const fd = openSync(tmpPath, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  opts.onStep?.("afterFileFsync");

  renameSync(tmpPath, join(opts.storeDir, relativePath));
  opts.onStep?.("afterRename");

  fsyncDir(dir);
  opts.onStep?.("afterDirFsync");

  return { relativePath, sha256, byteLength: opts.bytes.byteLength };
};
