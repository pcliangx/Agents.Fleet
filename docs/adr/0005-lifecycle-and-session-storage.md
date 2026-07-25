---
status: accepted
---
# 生命周期以 SQLite 为权威，Session 字节流独立持久化

Task、Attempt、Session、Worktree 绑定、命令幂等记录和低频领域事件必须原子一致，而高频 PTY 字节不适合与它们竞争同一事件表。决定：SQLite 是生命周期与命令结果的唯一权威存储，状态转换、幂等记录和对应领域事件在同一 transaction 中提交；Session 字节写入独立的 append-only chunk store，由 SQLite 保存 chunk 索引和校验信息。Snapshot 是可重建的缓存，不是第四份权威状态。

## Considered Options
- SQLite 状态 + 独立事件日志 + 独立 checkpoint 各自为权威——否，崩溃中途会产生无法判定的多份事实源。
- 所有 PTY 字节写入 SQLite 领域事件表——否，高频流量会放大写竞争、数据库体积和时间线查询成本。
- 生命周期 SQLite + 独立字节 chunk store——是，在保持生命周期原子性的同时隔离高频流。

## Consequences
Reconciliation 先读取 SQLite，再校验 chunk 索引和 Session owner；缺失或损坏的 Snapshot 可以重建，缺失 chunk 必须显式报告数据缺口。测试直接使用临时真实 SQLite 和临时文件系统，不为本地存储暴露仅供 mock 的外部 seam。写入必须使用 checksum、临时文件与原子 rename；磁盘压力不得导致静默丢失。
