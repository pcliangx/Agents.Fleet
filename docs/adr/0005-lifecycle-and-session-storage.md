---
status: accepted
---
# 生命周期以 SQLite 为权威，Session 字节流独立持久化

Task、Attempt、Session、Worktree 绑定、命令幂等记录和低频领域事件必须原子一致，而高频 PTY 字节不适合与它们竞争同一事件表。决定：SQLite 是生命周期与命令结果的唯一权威存储，状态转换、幂等记录和对应领域事件在同一 transaction 中提交；Session 原始字节写入独立的 append-only chunk store，由 SQLite 保存 chunk 索引、校验信息和 Durable Stream Cursor。Snapshot 是可重建的缓存，不是第四份权威状态。

一个 PTY frame 只有在覆盖它的 chunk 完成 checksum、文件 fsync、原子 rename、目录 fsync，并且索引与 Durable Stream Cursor 已提交 SQLite 后，才可向客户端发布为可恢复数据。Snapshot 只能覆盖不晚于 Durable Stream Cursor 且满足 ADR-0003 安全 checkpoint 的 seq。原始 chunk 原样保存；Snapshot 不进行内容替换式 redaction；二者均按敏感本地数据保护。redaction 只用于派生的时间线、索引、诊断日志和默认导出，脱敏结果不得回灌终端恢复链。

输入使用 Observation 而非虚假的 delivery acknowledgement：原始 bytes 的 content object 必须先完成 checksum、文件 fsync、原子 rename 与目录 fsync，随后才在 SQLite transaction 中持久化含 provenance 与 content identity 的 `InputIntent{Prepared}`；此后才能写 PTY。把 bytes 交给 PTY owner 后追加 `Dispatched` Observation。`node-pty` 不能证明子进程已经消费输入；若在两者之间崩溃，该 Input Intent 标为 Uncertain，绝不自动重放。Artifact / test output content 使用同一“content object 先 durable、metadata record 后提交”的方向，缺失或损坏时保留 metadata 并标记 data gap。

## Considered Options
- SQLite 状态 + 独立事件日志 + 独立 checkpoint 各自为权威——否，崩溃中途会产生无法判定的多份事实源。
- 所有 PTY 字节写入 SQLite 领域事件表——否，高频流量会放大写竞争、数据库体积和时间线查询成本。
- 生命周期 SQLite + 独立字节 chunk store——是，在保持生命周期原子性的同时隔离高频流。

## Consequences
Reconciliation 先读取 SQLite，再校验 chunk 索引、Durable Stream Cursor 和 Session owner；文件存在但没有索引的 chunk 是待校验 orphan，有索引但文件缺失是显式 data gap。缺失或损坏的 Snapshot 可以重建，缺失 chunk 必须显式报告数据缺口。测试直接使用临时真实 SQLite 和临时文件系统，不为本地存储暴露仅供 mock 的外部 Seam。Daemon 在 app-data 同 volume 保持 RT-BP-07 的 emergency metadata reserve；磁盘压力先暂停全部相关 producer，再持久化 Waiting / StoragePressure，不能静默丢失。崩溃测试必须覆盖每个持久化边界和 Input Intent / Dispatched 窗口。
