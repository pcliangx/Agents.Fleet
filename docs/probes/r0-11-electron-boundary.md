# R0-11 Slice A — Electron 边界原型

> Branch: `r0-11-electron-filebroker-checkout`(slice A,issue #10)。**本次实测**为以下契约提供 Electron 边界层面的证据:
> SV1-ELECTRON-01(private app protocol)、SV1-ELECTRON-02(sender/frame IPC 校验)、
> SV1-ELECTRON-03(navigation/new-window/webview/download/permission 默认拒绝)、
> SV1-ELECTRON-04(严格 CSP)、SV1-ELECTRON-05(fuse 固定与验证)、SV1-ELECTRON-06(最小 preload);
> 测试目标 SV1-T-16(全部 fail closed)、SV1-T-14(与既有 renderer-compromise fixture 互补)、
> SV1-T-04(Main IPC 一侧)与 SV1-T-21(fuse 线级部分)。
> SV1-ELECTRON-07(confirmation 面)、asar 打包后的 fuse 行为、MessagePort/Attachment 绑定**未在本次覆盖**,见「边界与后续」。
>
> 实测于 2026-07-26,macOS 26.5.2 (25F84) / Apple M5 Pro / node v26.4.0 / Electron 43.2.0(adhoc 签名 dev 二进制)。
> 方法:两个真实 Electron fixture——(1) `electron-boundary.test.ts` 把 `src/main/` 的**真实边界模块**就地
> transpile 进一次性 fixture app,再给它一个**故意暴露通用 invoke 的 preload**(模拟被攻陷的 Renderer),
> 逐项发起协议遍历、伪造 sender、subframe、navigation、new-window、webview、download、permission、CSP bypass 与
> 任意 channel 攻击;(2) `fuses.test.ts` 解析 dev Electron Framework 二进制的 fuse wire,并在 tmp 克隆上翻转
> 注入类 fuse、adhoc 重签后做**行为级**对照。证据: [`r0-11/electron-boundary-evidence.json`](r0-11/electron-boundary-evidence.json)。

## 结论

**在真实 Electron 43.2.0 上,本文实现的 Main 侧边界让全部攻击 fixture fail closed;同时实测证明
Electron 出厂 dev 二进制的默认 fuse 姿态(wire `101100011`,9 位 fuse;index 8 = WasmTrapHandlers)允许 `ELECTRON_RUN_AS_NODE` 与
`NODE_OPTIONS --require` 注入 Main 进程——SV1-ELECTRON-05 的 fuse 固定不是形式要求,而是真实风险,
发布构建必须在签名后拒绝默认 fuse 姿态。**

- **实测直接支持**:af-app 协议只服务安装包内 asset(遍历/host 伪造/symlink 逃逸 403/404 且无泄露);
  IPC 只接受预期 webContents 顶层 frame + 应用 origin(意外 webContents、subframe、已销毁 sender、
  已导航 frame、外部 origin 全部拒绝);navigation/new-window/webview/download/permission 默认拒绝;
  严格 CSP 拦截 eval/Function/外链 script/fetch/inline script 且放行 `'self'`;fuse wire 可从二进制解析,
  错误 fuse 姿态被 `verifyReleaseFuses` 判为 non-compliant(fail closed),翻转 fuse 的克隆在行为上关闭
  RunAsNode 与 NODE_OPTIONS 注入且仍可启动。
- **推断(非本次实测)**:打包成 asar 并签名公证后 `OnlyLoadAppFromAsar` /
  `EnableEmbeddedAsarIntegrityValidation` 的行为保证 —— 本 slice 只在 wire 层面验证,行为验证需要签名发布构建。

### 过程中的两个实证发现

1. **Node 与 Chromium 的 WHATWG URL 行为差异**:Main 进程里 `new URL("af-app://app/...").origin`
   返回 `"null"`(非 special scheme),而 Chromium 侧是 `af-app://app`。初版 origin 比较因此会把**合法**
   sender 也拒绝(fail closed 方向,但会误伤)。`ipc-guard.ts` 改为显式比较 protocol + host,
   并有回归测试。任何未来在 Main 进程做 origin 判断的代码都不能依赖 `URL.origin`。
2. **fuse wire 格式(实测确认)**:Electron Framework 二进制中 sentinel `dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX`
   之后是 1 字节 version(=1)+ 1 字节 length(=8)+ 8 个 ASCII `0`/`1` 标志,顺序即 `FuseKey` 枚举序
   (RunAsNode, EnableCookieEncryption, EnableNodeOptionsEnvironmentVariable, EnableNodeCliInspectArguments,
   EnableEmbeddedAsarIntegrityValidation, OnlyLoadAppFromAsar, LoadBrowserProcessSpecificV8Snapshot,
   GrantFileProtocolExtraPrivileges)。dev 二进制实测为 `10110001`。

## 实现(Main 侧,`apps/desktop/src/main/`)

| 模块 | 契约 | 职责 |
| --- | --- | --- |
| `asset-path.ts` | SV1-ELECTRON-01 | 纯路径解析:只返回 asset root 内真实文件;拒绝 `..`、NUL、反斜杠、host/port/userinfo 伪造、symlink 逃逸 |
| `app-protocol.ts` | SV1-ELECTRON-01 | `af-app` scheme 注册(`standard+secure+supportFetchAPI+stream`)与 handler;miss = 404,**无网络 fallback** |
| `csp.ts` | SV1-ELECTRON-04 | `default-src 'none'; script/style/img/font/connect/frame-src 'self'; base-uri/form-action 'none'; frame-ancestors 'none'`;响应头 + webRequest 双层 |
| `window-guard.ts` | SV1-ELECTRON-03 | 每个 webContents / session 的 will-navigate、setWindowOpenHandler、will-attach-webview、will-download、permission request/check 全部默认拒绝,经 `web-contents-created` 覆盖一切窗口 |
| `external-url.ts` | SV1-ELECTRON-03 | 外部 URL 独立策略:仅 https + 显式用户手势 + 可选 host allowlist + 系统默认浏览器(`shell` 注入,便于测试) |
| `ipc-guard.ts` | SV1-ELECTRON-02 | 纯校验:预期 webContents、顶层 frame、应用 origin,缺一项即拒(注释记录了 schema/速率/route capability 属 Daemon 侧) |
| `trusted-ipc.ts` | SV1-ELECTRON-02 | `handleTrustedIpc`:所有 channel 必须经校验注册,拒绝即 throw,fail closed |
| `fuses.ts` | SV1-ELECTRON-05 | fuse wire 解析 / `REQUIRED_RELEASE_FUSES` 验证（`flipFuseWire` 为攻击 fixture 专用工具，已移至 `src/__tests__/flip-fuse-wire.ts`，production Main 不携带 fuse 改写能力） |
| `index.ts` | SV1-ELECTRON-05 | 装配：release 走 `af-app://app/index.html`，dev 走 `ELECTRON_RENDERER_URL`；IPC origin 白名单绑定实际加载 origin；启动时先执行 fuse 姿态验证——`app.isPackaged` 时 non-compliant 或不可读即 fail closed 拒绝启动（dev 二进制出厂 fuse 不合规，跳过） |

Renderer(`src/renderer/`)已改为外链 `app.js` / `style.css`(无 inline script/style),使
`script-src 'self'` 成立;daemon 状态文本只经 `textContent` 渲染(SV1-ELECTRON-04)。

## 实测矩阵(SV1-T-16 逐项)

全部在**真实 Electron 进程**内执行,攻击方 preload 被故意赋予通用 `invoke(channel, ...)`——
即假设 Renderer 已被攻陷,边界仍须成立。实测值见证据 JSON。

| 攻击 | 结果(实测) |
| --- | --- |
| 正常 asset `af-app://app/index.html` | 200,无泄露 |
| 字面 `..` / `%2e%2e` 遍历 | 404(Chromium URL 解析先归一化),无泄露 |
| `%5c` 反斜杠 / `%00` NUL | 403,无泄露 |
| host 伪造 `af-app://evil.example/...` | 403 |
| asset root 内 symlink → root 外 secret | 403(realpath 双侧校验),无泄露 |
| 不存在 asset | 404(**非**网络 fallback) |
| 目录请求 | 403 |
| 受信窗口调用声明 channel | 成功返回 |
| 任意 channel 名 invoke | `No handler registered`(SV1-ELECTRON-06) |
| 同 origin 另一窗口调用 | `IPC denied (unexpected webContents)` |
| 受信窗口内 subframe | validator 拒绝(`subframe sender`);main frame 通过 |
| 已销毁 webContents | 拒绝(`destroyed sender`) |
| 受信窗口被导航到 `data:` 后调用 | `IPC denied (unexpected frame origin)` |
| `location.href` 导航到 https | 被 will-navigate 拦截,URL 不变 |
| `window.open` / `target=_blank` | 返回 null / 无新窗口(窗口数恒为 2) |
| `<webview>`(webviewTag 开启的 fixture 窗口) | attach 被拦截,guest 数 0 |
| `downloadURL` | will-download 拦截 |
| `getUserMedia` / `Notification.requestPermission` | `denied:NotAllowedError` / `denied` |
| CSP:`eval` / `new Function` | 均抛错被拦 |
| CSP:外链 script / fetch https | 均被拦(加载前) |
| CSP:inline `<script>` 页面 | `window.pwned === undefined` |
| CSP:`'self'` 外链 app.js | 正常运行(对照) |
| dev 形态:http origin 显式绑定 | 允许;切回 af-app origin 即拒绝 |

dev-only 与 release 形态差异在测试中被显式区分:release 走 af-app + CSP;dev 走
`http://127.0.0.1:<port>`,IPC origin 白名单绑定实际加载 origin,切错 origin 立即拒绝。

## fuse 实测(SV1-ELECTRON-05)

| 项 | dev 出厂二进制(`10110001`) | 翻转后克隆(注入类 fuse 关) |
| --- | :-: | :-: |
| `ELECTRON_RUN_AS_NODE=1 electron -p "40+2"` | **输出 `42`(可注入)** | 不执行 payload(报错/空转,非 0 退出) |
| `NODE_OPTIONS=--require marker.cjs` | **Main 进程被注入,marker 写入** | marker 不存在,app 正常启动退出 0 |
| `verifyReleaseFuses` 判定 | non-compliant(RunAsNode 等 6 项违规) | 注入类违规消除;仍 non-compliant(OnlyLoadAppFromAsar 等未翻) |

方法:tmp 目录 `cp` 整个 Electron.app → 修改 Framework 二进制 fuse 字节 → `codesign --force --sign -`
adhoc 重签(arm64 要求有效签名)→ 行为对照。node_modules 只读未动。错误 fuse / 不可解析 wire
在 release 验证中一律 fail closed(合成 wire 单测覆盖)。

## 证据与复现

- 边界实现:`apps/desktop/src/main/`(`asset-path.ts`、`app-protocol.ts`、`csp.ts`、`window-guard.ts`、`external-url.ts`、`ipc-guard.ts`、`trusted-ipc.ts`、`fuses.ts`、`index.ts`)
- 攻击 fixture:`apps/desktop/src/__tests__/electron-boundary.test.ts`(真实 Electron spawn,SV1-T-16 核心)
- fuse fixture:`apps/desktop/src/__tests__/fuses.test.ts`(wire 解析单测 + dev 二进制判定 + 翻转克隆行为对照)
- 单元测试:`asset-path.test.ts`(20)、`ipc-guard.test.ts`(8)、`external-url.test.ts`(10)
- 既有补充:`renderer-compromise.test.ts`(SV1-T-14:Renderer 无 require/process、不能动态加载 node-pty)、`preload/desktop-api.test.ts`(preload 面只有命名方法)
- 证据:[`r0-11/electron-boundary-evidence.json`](r0-11/electron-boundary-evidence.json)(脱敏;fixture 路径均在 `$TMPDIR`,不落入证据)
- 复现:`pnpm vitest run apps/desktop`(46 tests 全绿);原始 fixture JSON 可用
  `AF_PROBE_EVIDENCE=1 pnpm vitest run apps/desktop/src/__tests__/electron-boundary.test.ts` 打出

## 边界与后续(本次未覆盖)

- **asar 打包后的 fuse 行为**:`OnlyLoadAppFromAsar` / `EnableEmbeddedAsarIntegrityValidation` 只在 wire 层验证;
  行为验证需要打包 + 签名 + 公证的发布构建(SV1-SUPPLY-03 / SV1-T-21 完整版),属发布流水线 slice。
- **`NODE_EXTRA_CA_CERTS` 无专用 fuse**:本 slice 实测了 `NODE_OPTIONS` 注入的开/关;`NODE_EXTRA_CA_CERTS`
  由 Node TLS 层直接读取,Electron 无独立 fuse,需在分发层(hardened runtime / 启动环境控制)定策,已列为开放边界。
- **SV1-ELECTRON-06 后半**:绑定 Attachment 的 MessagePort 尚未存在(R0 无 stream);通用 send/invoke、
  Node object、任意 channel 名的不暴露已由 desktop-api 单测 + 任意 channel fixture 覆盖。
- **SV1-ELECTRON-02 尾部**:payload schema、`RuntimeLimitProfile` 大小/速率、route capability 属 Daemon 侧
  (SV1-AUTH-06),待 R0-16 冻结 profile 后在 transport 层验证。
- **SV1-ELECTRON-07**:Trust / destructive / Launch Confirmation 原生确认面不在本 slice。
- **SV1-T-04 的 Daemon 半侧**:本 slice 证明 Renderer 无法借任意 channel/payload 越过 Main;Daemon schema
  拒绝由 transport/contracts slice 覆盖。
- `web-contents-created` 钩子覆盖一切窗口;will-navigate 只拦 Renderer 发起的导航,Main 自己的 `loadURL`
  是受信路径(代码评审点,非漏洞)。
- CSP 经自定义协议响应头生效已行为验证;`onHeadersReceived` 双保险层未单独证明其独立效力。
- 单平台单采样(macOS 26.5.2 / M5 Pro);`SupportedPlatformMatrix`(R0-15)冻结后需在最低 macOS/硬件复测。
