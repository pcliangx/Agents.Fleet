---
status: accepted
---
# 执行器独立成 OS daemon

长任务必须跨 UI 关闭、UI 崩溃、甚至机器重启存活——UI 进程不能拥有 Agent。决定:执行器作为独立的 OS 级 daemon(macOS launchd)运行,拥有 PTY、子进程与权威状态;Electron 桌面只是它的一个客户端。所有领域命令经单一 Control API dispatcher 进入,Electron IPC 以及未来的 CLI/Web/Mobile 都只是 transport adapter,不复制领域 handler。

## Considered Options
- 嵌入 Electron 主进程——否,关 app 或主进程崩溃即杀光整个舰队,违背核心不变量。
- App 派生的 detached 子进程——否,扛不住机器重启,也无自动恢复。
- 独立 OS daemon——是,唯一能扛重启并自动 reconcile 的形态。

## Consequences
需承担 daemon 生命周期管理:作为服务安装、版本握手、孤儿 Session 清理、socket 鉴权,以及升级时不能误杀长任务。
