// SV1-FILE-01/02/03/08 — FileBroker: Worktree Manager 的私有文件操作 Implementation。
//
// Node.js 没有 openat 绑定；本原型用纯 Node 内置能力兑现「相对已验证
// directory 身份逐段解析」的等价语义（证据：docs/probes/r0-11-filebroker.md）：
//
// - 候选 1 `/dev/fd/<dirfd>/<subpath>` 穿透：macOS 实测 ENOENT，fdesc 不支持
//   子路径解析；`process.chdir("/dev/fd/N")` 实测 ENOTDIR。不可用。
// - 候选 2 逐段 lstat + 字符串路径 open(O_NOFOLLOW) + fstat 比对：实测在
//   并发 symlink swap 下 5000 次迭代逃逸 289 次 —— 检查与打开绑定的是字符串
//   路径而非目录 vnode，中间段可被替换。不满足 SV1-FILE-03，已拒绝。
// - 候选 3 fs.opendir 的 Dir handle：不暴露 dirfd，也无相对 open API。不可用。
// - 选定机制（候选 4）：chdir 梯子 —— lstat(root) 身份重验 → chdir(root) →
//   stat(".") 与注册身份比对（把「检查」绑定到实际进入的 vnode）→ 逐段
//   lstat(拒 symlink) + chdir(段) + stat(".") 与该段 lstat 的 dev/ino 比对 →
//   末段 open(O_NOFOLLOW) + fstat 与末段 lstat 比对。每一跳都把后续解析锚定
//   在已进入的目录 vnode 上，与 macOS openat(O_NOFOLLOW) 逐段语义等价；
//   实测并发 symlink swap 5000 次迭代 0 逃逸（SV1-T-17）。
//
// 已知的诚实边界（写入 probe 文档）：cwd 是进程全局状态，梯子全程同步执行，
// 依赖 Node 单线程模型；与 Worker 并发 chdir 不兼容（SV1-FILE-08 fail closed
// 的前提之一）。外部目录 rename 进树内无法被任何 fd 相对机制（含 macOS 原生
// openat）区分 —— macOS 没有 openat2 RESOLVE_BENEATH；本原型与原生 openat
// 在此攻击面上语义相同。生产实现应以 N-API 包装真实 openat(2) 消除进程全局
// cwd 依赖（R1 后续）。

import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  type Stats,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute } from "node:path";
import type { FilesystemIdentity } from "../git/restricted-git.js";

// SV1-FILE-01 的 filesystem identity 概念只有单一类型来源（R0-05 的
// restricted-git.ts），此处 re-export 以保持本模块的对外形状不变。
export type { FilesystemIdentity };

// SV1-FILE-10 — common-git-dir 仅供 Worktree Manager 内部的 provision /
// inspect / dispose 复合流程以已验证 identity 访问 common Git directory；
// 它绝不能作为 Renderer 可浏览的 root 暴露（SV1-T-26）。
export type RootKind = "repository" | "worktree" | "app-data" | "common-git-dir";

/** 声明式 root 注册结果；id 不透明，Renderer 侧不可伪造（SV1-FILE-08：私有 Implementation）。 */
export interface RegisteredRoot {
  readonly id: string;
  readonly kind: RootKind;
  readonly canonicalRoot: string;
  readonly identity: FilesystemIdentity;
  readonly registeredAt: string;
}

export type RelativeFileHashResult =
  | {
      readonly ok: true;
      readonly entryType: "file" | "symlink";
      readonly contentHash: string;
      readonly bytes: number;
    }
  | {
      readonly ok: false;
      readonly reason: "byte-limit" | "duration-limit" | "unsupported-entry" | "read-failed";
      readonly detail: string;
    };

export type FileBrokerFailureReason =
  /** 绝对路径、`..`、NUL、空段（SV1-FILE-02）。 */
  | "invalid-path"
  /** 未注册的 root id（跨 root handle 复用/伪造，SV1-FILE-02 / SV1-T-26）。 */
  | "unknown-root"
  /** root 或中间段的文件系统 identity 与已验证值不符（SV1-FILE-01/03，fail closed）。 */
  | "identity-drift"
  /** 路径中出现 symlink（含越界 symlink，SV1-FILE-02）。 */
  | "symlink-rejected"
  /** 检查与进入/打开之间 identity 改变（SV1-T-17：失败而非落到攻击者路径）。 */
  | "race-lost"
  /** 目标不存在或类型不符。 */
  | "not-found"
  /** 平台能力缺失（SV1-FILE-08：native 能力缺失 fail closed）。 */
  | "capability-unavailable";

export class FileBrokerError extends Error {
  readonly reason: FileBrokerFailureReason;
  constructor(reason: FileBrokerFailureReason, detail: string) {
    super(`FileBroker ${reason}: ${detail}`);
    this.name = "FileBrokerError";
    this.reason = reason;
  }
}

const fail = (reason: FileBrokerFailureReason, detail: string): never => {
  throw new FileBrokerError(reason, detail);
};

// SV1-FILE-02 — 相对路径词法校验：拒绝绝对路径、`..`、NUL、空段、"."段。
// 纯词法检查，不触碰文件系统。
export const parseRelativePath = (p: string): readonly string[] => {
  if (p.length === 0 || p.includes("\u0000")) fail("invalid-path", "NUL byte or empty path");
  if (isAbsolute(p)) fail("invalid-path", `absolute path rejected: ${p}`);
  const segments = p.split("/");
  for (const s of segments) {
    if (s === "" || s === "." || s === "..") {
      fail("invalid-path", `illegal segment ${JSON.stringify(s)} in path: ${p}`);
    }
  }
  return segments;
};

const identityOf = (st: { dev: number; ino: number }): FilesystemIdentity => ({
  dev: st.dev,
  ino: st.ino,
});

const sameIdentity = (a: FilesystemIdentity, b: FilesystemIdentity): boolean =>
  a.dev === b.dev && a.ino === b.ino;

export class FileBroker {
  private readonly roots = new Map<string, RegisteredRoot>();
  private nextRootSeq = 0;

  // SV1-FILE-08 — 构造即探测平台能力，缺失则 fail closed，不静默降级。
  constructor() {
    if (typeof process.chdir !== "function" || typeof constants.O_NOFOLLOW !== "number") {
      fail("capability-unavailable", "chdir / O_NOFOLLOW unavailable on this platform");
    }
    if (process.platform !== "darwin" && process.platform !== "linux") {
      fail("capability-unavailable", `unsupported platform: ${process.platform}`);
    }
  }

  /**
   * SV1-FILE-01 — root 首次使用前 canonicalize（realpath）并保存稳定
   * identity（dev/ino）。root 自身必须是非 symlink 目录（realpath 之后
   * lstat， symlink 已在 canonicalize 中解掉，这里确认落点是目录）。
   */
  registerRoot(kind: RootKind, path: string): RegisteredRoot {
    let canonical: string;
    try {
      canonical = realpathSync(path);
    } catch (e) {
      throw new FileBrokerError(
        "not-found",
        `cannot canonicalize root ${path}: ${(e as Error).message}`,
      );
    }
    const st = lstatSync(canonical);
    if (!st.isDirectory()) fail("invalid-path", `root is not a directory: ${canonical}`);
    const root: RegisteredRoot = {
      id: `root-${++this.nextRootSeq}`,
      kind,
      canonicalRoot: canonical,
      identity: identityOf(st),
      registeredAt: new Date().toISOString(),
    };
    this.roots.set(root.id, root);
    return root;
  }

  /** SV1-FILE-02 — 每次操作只按命令声明的单一 root id 解析；未知 id 一律拒绝。 */
  private declaredRoot(rootId: string): RegisteredRoot {
    const root = this.roots.get(rootId);
    if (root === undefined) {
      throw new FileBrokerError("unknown-root", `no such registered root: ${rootId}`);
    }
    return root;
  }

  /**
   * SV1-FILE-03 — 核心解析器：相对已验证 root 逐段解析并打开末段。
   * 全程同步：cwd 是进程全局状态，同步段内无其他 JS 交错，每跳由
   * lstat → chdir → stat(".") 三步把「检查」与「进入」绑定到同一 vnode。
   * 任何一步 identity 不符即 fail closed（SV1-FILE-08），绝不落到替换后的路径。
   *
   * 返回已打开的 fd（调用方负责 closeSync）。fd 一旦打开即钉住 vnode，
   * 之后的 rename/swap 不影响本次操作（SV1-T-17「操作原已验证 identity」分支）。
   */
  private openRelative(
    root: RegisteredRoot,
    segments: readonly string[],
    flags: number,
    create: boolean,
  ): number {
    const savedCwd = process.cwd();
    try {
      // SV1-FILE-01 — 每次敏感操作重新验证所声明 root 的 identity。
      // pre-check：路径当前指向的必须是注册时的同一 vnode；路径暂时消失
      // （替换窗口）也无法证明 identity，同样 fail closed。
      let pre: Stats;
      try {
        pre = lstatSync(root.canonicalRoot);
      } catch {
        throw new FileBrokerError("identity-drift", `root path unavailable: ${root.canonicalRoot}`);
      }
      if (!pre.isDirectory() || !sameIdentity(identityOf(pre), root.identity)) {
        fail("identity-drift", `root identity changed: ${root.canonicalRoot}`);
      }
      // 进入 root 并 post-check：把检查绑定到实际进入的 vnode，
      // 关闭 pre-check 与 chdir 之间的替换窗口（SV1-T-17）。
      try {
        process.chdir(root.canonicalRoot);
      } catch {
        fail("race-lost", `root vanished between check and enter: ${root.canonicalRoot}`);
      }
      const entered = statSync(".");
      if (!sameIdentity(identityOf(entered), root.identity)) {
        fail("race-lost", `root swapped between check and enter: ${root.canonicalRoot}`);
      }

      // 中间段：逐段 lstat（拒 symlink）→ chdir → stat(".") 比对该段 lstat
      // 的 dev/ino。进入后 cwd 锚定 vnode，之后对该名字的替换不影响我们。
      for (let i = 0; i < segments.length - 1; i++) {
        const seg = segments[i] as string;
        let lst: Stats;
        try {
          lst = lstatSync(seg);
        } catch {
          throw new FileBrokerError("not-found", `segment not found: ${seg}`);
        }
        if (lst.isSymbolicLink()) {
          fail("symlink-rejected", `symlink segment rejected: ${seg}`);
        }
        if (!lst.isDirectory()) {
          fail("not-found", `intermediate segment is not a directory: ${seg}`);
        }
        try {
          process.chdir(seg);
        } catch {
          fail("race-lost", `segment vanished between check and enter: ${seg}`);
        }
        const got = statSync(".");
        if (!sameIdentity(identityOf(got), identityOf(lst))) {
          fail("race-lost", `segment swapped between check and enter: ${seg}`);
        }
      }

      // 末段：lstat 拒 symlink；open(O_NOFOLLOW) 防 lstat→open 间换入
      // symlink；fstat 比对 lstat 的 dev/ino 防换入另一同名文件。
      const leaf = segments[segments.length - 1] as string;
      let lst: Stats;
      try {
        lst = lstatSync(leaf);
      } catch {
        if (!create) throw new FileBrokerError("not-found", `target not found: ${leaf}`);
        // 新建：O_CREAT|O_EXCL —— lstat 说不存在之后任何人抢先创建
        // （含 symlink）都让 open 失败，而不是落到抢占者的文件上。
        try {
          return openSync(
            leaf,
            flags | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600,
          );
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === "EEXIST" || code === "ELOOP") {
            throw new FileBrokerError(
              "race-lost",
              `target appeared between check and create: ${leaf}`,
            );
          }
          throw e;
        }
      }
      if (lst.isSymbolicLink()) {
        fail("symlink-rejected", `symlink target rejected: ${leaf}`);
      }
      if (create && !lst.isFile()) {
        fail("invalid-path", `write target is not a regular file: ${leaf}`);
      }
      if (!create && !lst.isFile()) {
        fail("not-found", `read target is not a regular file: ${leaf}`);
      }
      let fd: number;
      try {
        fd = openSync(leaf, flags | constants.O_NOFOLLOW, 0o600);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ELOOP") fail("race-lost", `symlink swapped in before open: ${leaf}`);
        if (code === "ENOENT") fail("not-found", `target vanished: ${leaf}`);
        throw e;
      }
      const fst = fstatSync(fd);
      if (!sameIdentity(identityOf(fst), identityOf(lst))) {
        closeSync(fd);
        fail("race-lost", `target swapped between check and open: ${leaf}`);
      }
      return fd;
    } finally {
      // 无论成败都恢复 cwd；失败路径绝不留下半进入的状态。
      process.chdir(savedCwd);
    }
  }

  /**
   * SV1-FILE-02 — 单次操作只相对该命令声明并验证的单一 root 解析。
   * 没有按字符串路径解析的重载，调用方无法拼接路径或更换 root 扩大访问。
   */
  readFile(rootId: string, relativePath: string): Buffer {
    const root = this.declaredRoot(rootId);
    const segments = parseRelativePath(relativePath);
    const fd = this.openRelative(root, segments, constants.O_RDONLY, false);
    try {
      return readFileSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  /**
   * RT-EVIDENCE-03 — stream-hash one regular file relative to a declared
   * Worktree root. The fd is opened through the same identity-checked ladder
   * as readFile; no symlink is followed and bytes never accumulate in memory.
   */
  hashFile(
    rootId: string,
    relativePath: string,
    options: { readonly maxBytes: number; readonly deadlineMs: number },
  ): RelativeFileHashResult {
    const root = this.declaredRoot(rootId);
    const segments = parseRelativePath(relativePath);
    let fd: number;
    try {
      fd = this.openRelative(root, segments, constants.O_RDONLY, false);
    } catch (error) {
      if (error instanceof FileBrokerError) {
        if (error.reason === "symlink-rejected") {
          return this.hashSymlink(root, segments, options);
        }
        return {
          ok: false,
          reason: error.reason === "capability-unavailable" ? "unsupported-entry" : "read-failed",
          detail: error.reason,
        };
      }
      return { ok: false, reason: "read-failed", detail: "open failed" };
    }

    try {
      const before = fstatSync(fd);
      if (!before.isFile()) {
        return { ok: false, reason: "unsupported-entry", detail: "entry is not a regular file" };
      }
      if (before.size > options.maxBytes) {
        return { ok: false, reason: "byte-limit", detail: "file exceeds remaining byte budget" };
      }
      const hash = createHash("sha256");
      const chunk = Buffer.allocUnsafe(1024 * 1024);
      let bytes = 0;
      for (;;) {
        if (performance.now() > options.deadlineMs) {
          return {
            ok: false,
            reason: "duration-limit",
            detail: "file hashing exceeded duration budget",
          };
        }
        const read = readSync(fd, chunk, 0, chunk.length, null);
        if (read === 0) break;
        bytes += read;
        if (bytes > options.maxBytes) {
          return { ok: false, reason: "byte-limit", detail: "file exceeded byte budget" };
        }
        hash.update(chunk.subarray(0, read));
      }
      const after = fstatSync(fd);
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      ) {
        return { ok: false, reason: "read-failed", detail: "file changed while hashing" };
      }
      return { ok: true, entryType: "file", contentHash: hash.digest("hex"), bytes };
    } catch {
      return { ok: false, reason: "read-failed", detail: "file read failed" };
    } finally {
      closeSync(fd);
    }
  }

  /**
   * Untracked symlink content is its link-target bytes, never the target file.
   * The same chdir ladder pins every parent directory; lstat/readlink/lstat
   * ensures the leaf symlink did not change while observed.
   */
  private hashSymlink(
    root: RegisteredRoot,
    segments: readonly string[],
    options: { readonly maxBytes: number; readonly deadlineMs: number },
  ): RelativeFileHashResult {
    const savedCwd = process.cwd();
    try {
      const pre = lstatSync(root.canonicalRoot);
      if (!pre.isDirectory() || !sameIdentity(identityOf(pre), root.identity)) {
        return { ok: false, reason: "read-failed", detail: "root identity drifted" };
      }
      process.chdir(root.canonicalRoot);
      if (!sameIdentity(identityOf(statSync(".")), root.identity)) {
        return { ok: false, reason: "read-failed", detail: "root race lost" };
      }
      for (let index = 0; index < segments.length - 1; index++) {
        const segment = segments[index] as string;
        const before = lstatSync(segment);
        if (!before.isDirectory() || before.isSymbolicLink()) {
          return {
            ok: false,
            reason: "unsupported-entry",
            detail: "symlink or non-directory parent",
          };
        }
        process.chdir(segment);
        if (!sameIdentity(identityOf(statSync(".")), identityOf(before))) {
          return { ok: false, reason: "read-failed", detail: "parent race lost" };
        }
      }
      if (performance.now() > options.deadlineMs) {
        return { ok: false, reason: "duration-limit", detail: "symlink hashing timed out" };
      }
      const leaf = segments[segments.length - 1] as string;
      const before = lstatSync(leaf);
      if (!before.isSymbolicLink()) {
        return { ok: false, reason: "unsupported-entry", detail: "entry is not a symlink" };
      }
      const target = readlinkSync(leaf, { encoding: "buffer" });
      if (target.length > options.maxBytes) {
        return { ok: false, reason: "byte-limit", detail: "symlink exceeds byte budget" };
      }
      const after = lstatSync(leaf);
      if (
        !sameIdentity(identityOf(before), identityOf(after)) ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      ) {
        return { ok: false, reason: "read-failed", detail: "symlink changed while hashing" };
      }
      return {
        ok: true,
        entryType: "symlink",
        contentHash: createHash("sha256").update(target).digest("hex"),
        bytes: target.length,
      };
    } catch {
      return { ok: false, reason: "read-failed", detail: "symlink read failed" };
    } finally {
      process.chdir(savedCwd);
    }
  }

  /**
   * 与 readFile 同一解析器；写入 Fleet 自有数据（mode 0600，SV1-DATA-02 形状）。
   * 不创建中间目录，不跟随 symlink（O_NOFOLLOW），不截断 identity 不符的文件。
   */
  writeFile(rootId: string, relativePath: string, data: Buffer | string): void {
    const root = this.declaredRoot(rootId);
    const segments = parseRelativePath(relativePath);
    const fd = this.openRelative(root, segments, constants.O_WRONLY | constants.O_TRUNC, true);
    try {
      writeFileSync(fd, data);
    } finally {
      closeSync(fd);
    }
  }
}
