// SV1-T-17 / SV1-T-26 race fixture — 攻击者进程：高频把已注册的 `root`
// 在原始目录与攻击者目录之间原子替换（rename）。broker 每次操作都必须
// 重新验证 root identity：要么落在原始已验证 identity 上，要么失败，
// 绝不读到攻击者目录内容。
// 用法: node race-root-attacker.mjs <root> <rootReal> <rootAttacker>
import fs from "node:fs";

const [root, rootReal, rootAttacker] = process.argv.slice(2);

for (;;) {
  try {
    fs.renameSync(root, rootReal);
    fs.renameSync(rootAttacker, root);
  } catch {}
  try {
    fs.renameSync(root, rootAttacker);
    fs.renameSync(rootReal, root);
  } catch {}
}
