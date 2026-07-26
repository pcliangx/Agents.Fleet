// R0-14 — content object 的文件 durability 协议（RT-STO-02 / RT-STO-11 共用形状）：
// 写临时文件 → checksum → 文件 fsync → 原子 rename → 目录 fsync。
// rename 只对同目录的临时文件生效（同 volume，原子）；完成 rename 的
// 文件即「完整写入且已 fsync」，这是 Reconciliation 能接纳 orphan 的依据。

import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from "node:fs";
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
