---
status: accepted
---
# Electron 终端使用上游 xterm.js，Daemon 使用 node-pty

持续观察和控制 CLI Agent 是核心场景，v1 更需要经过 Electron 产品验证的输入法、Unicode、selection、clipboard、accessibility 与渲染行为，而不是自行建设浏览器终端前端。决定：Renderer 使用随应用发布且精确锁定版本的 `@xterm/xterm`；官方 `@xterm/addon-webgl` 提供首选 WebGL2 绘制路径，DOM renderer 是强制回退；用户级 Daemon 使用 `node-pty` 拥有 PTY、进程组和原始字节流，并以 `encoding: null` 接收 `Buffer`，不让字符串解码成为字节权威。Electron Main 只转发经过鉴权的 control / stream，Renderer 永远不取得 `node-pty`、PTY fd 或 Daemon socket。

Terminal Surface Module 拥有 xterm.js instance、允许的官方 addon 生命周期、终端选项、IME、键盘、鼠标、selection、clipboard 和 accessibility 集成，对业务 UI 只暴露 Agents.Fleet 的稳定 Interface。Session Runtime 可以在 Daemon 内按需启动由兼容版本 `@xterm/headless`、`@xterm/addon-serialize` 与 `@xterm/addon-unicode11` 构成的 Snapshot Worker，严格重放持久化 chunk 并生成 app-owned、非 HTML 的版本化 Snapshot；Worker 不加载 `node-pty`，也不拥有 PTY、输入或生命周期状态。流协议、Snapshot schema、cursor、generation、fencing 与背压仍由 Agents.Fleet 契约拥有，xterm.js buffer 不能成为生命周期权威。

Snapshot 的 `coversThroughSeq` 只能推进到同时满足 `parserGround` 与 `utf8DecoderEmpty`、且已经持久化的安全 checkpoint。xterm.js `write` completion callback 只表示这次写入处理完成，不能证明任意 byte / frame 边界可序列化；未跨过安全 checkpoint 的原始字节保留为 delta。若受支持的上游版本不能公开或可靠证明这两个条件，R0 必须以 byte-split fixture 验证一个有 owner、回归测试、升级预算和退出条件的最小下游补丁；在证明完成前不得推进 Snapshot cursor，也不得降低 `publishedButUnrecoverableFrameCount = 0` 与 Durable Stream Cursor 内 `missingByteCount = 0` 的门槛。

## Considered Options
- 上游 xterm.js + WebGL2 / DOM + node-pty——是，以较小 Interface 获得成熟的浏览器终端实现，并让 PTY 所有权留在 Daemon。
- libghostty-vt WASM + 自研 WebGPU / Canvas renderer——否，需要自行承担字体、绘制、IME、selection、clipboard 和 accessibility，扩大 v1 用户体验与维护风险。
- 从第一版开始维护 xterm.js 下游补丁——否，当前没有已测量的上游缺口、明确 owner 或升级预算。
- 最小化 spawn + tail——否，无法可靠 attach 同一个 Session，也无法提供 Restored View。

## Consequences
WebGL2 不可用、初始化失败或 context lost 时，Terminal Surface 必须释放 WebGL addon，并让同一个 xterm.js instance 原位使用 DOM renderer；不得创建新 Session、Attachment 或 parser，也不得重放已经应用的 seq。Snapshot 使用 Agents.Fleet 自有的版本化 schema，并可在没有 Electron UI 时由 headless Snapshot Worker 生成；不得持久化 xterm.js 私有 buffer、DOM、texture 或 HTML serialization，版本不兼容时从已校验 chunk 重建。

终端 package allowlist 仅包含 `@xterm/xterm`、`@xterm/headless`、`@xterm/addon-webgl`、`@xterm/addon-serialize` 与 `@xterm/addon-unicode11`；它们必须锁定兼容的精确版本和包完整性并随签名应用发布，运行时不得从 CDN 或网络加载终端代码。`@xterm/addon-unicode11` 纳入 allowlist 是因为 xterm 6 核心默认宽度表把部分 emoji 标为 width 1，导致终端对齐错位；该 addon 提供 Unicode 11 宽度 / 字素表修正 emoji 与 CJK 宽度，且 live Terminal 与 headless Snapshot Worker 必须加载同一版本以保证 Renderer 与 Worker 的 grid / cursor 一致（R0-09 实测验证）。v1 不加载 `addon-image`，image protocol 只按有界、不产生 Host 副作用的未知效果处理。title、OSC 8、clipboard、bell 等效果统一交给私有 `TerminalEffectPolicy` Implementation；escape sequence 不能直接调用 Host 能力。

Terminal Surface 的正确性通过同一组 Interface 测试验证 WebGL2 与 DOM；输入延迟、Unicode / emoji / CJK / IME、无效 UTF-8、reflow、selection、clipboard、accessibility、Renderer reload 和高输出负载都是发布门槛。若上游版本无法通过某项可复现验收，只有在具备最小补丁、owner、升级预算、回归测试和退出条件后才允许维护下游补丁；v1 不维护第二套生产终端后端。
