// SV1-T-17 race fixture — 攻击者进程：高频把 `sub` 在真实目录与指向
// root 外部的 symlink 之间原子切换（rename 是 POSIX 原子操作）。
// 用法: node race-attacker.mjs <sub> <subReal> <outside>
import fs from "node:fs";

const [sub, subReal, outside] = process.argv.slice(2);

for (;;) {
  try {
    fs.renameSync(sub, subReal);
    fs.symlinkSync(outside, sub);
  } catch {}
  try {
    fs.rmSync(sub);
    fs.renameSync(subReal, sub);
  } catch {}
}
