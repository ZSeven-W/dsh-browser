# dsh-browser

[English](README.md) · 简体中文

面向 DeepSeek Harness 的 Headless-first 托管式 Browser Use。每个 Agent 独占一个临时 Chrome / Edge / Chromium 用户目录，并通过短期语义引用、确定性高风险拦截和有界证据进行操作。

当前版本：`0.1.0-rc.1`。这是本地开发版本，尚未发布到 npm。

## 产品边界

`dsh-browser` 不接管个人浏览器，也不会把 CSS Selector 暴露给模型。所有工具调用都由 `exec.agent.id` 隔离：Agent 只能观察和操作自己拥有的浏览器 Context。

```text
Agent A ── 临时 Chromium Context A ── opaque refs A
Agent B ── 临时 Chromium Context B ── opaque refs B
                                  └──── 有界 Console / Network 证据
```

插件同时提供 `zsevenBrowserDriver` 服务，作为后续 `dsh-qa` 的稳定编排接口。

## 五个工具

| 工具 | 作用 |
| --- | --- |
| `browser_session_start` | 发现已安装的 Chrome / Edge / Chromium，启动独立 Context。 |
| `browser_observe` | 返回有界语义视图，以及绑定 epoch / fingerprint / expiry 的 opaque ref。 |
| `browser_act` | 实时重新解析并校验目标后执行 `click`、`fill`、`press`、`navigate`、`scroll`、`select` 或 `hover`。 |
| `browser_evidence` | 返回有界、脱敏的 Console 和 Network 元数据。 |
| `browser_session_stop` | 关闭 Context，删除对应的精确临时用户目录。 |

每次 `browser_act` 都返回收据：

- `confirmed`：浏览器完成了经校验的输入派发，但不代表业务结果一定成功。
- `unknown`：动作可能已派发，但取消、导航或运行时异常使最终状态无法确认。
- `rejected`：策略、过期引用、语义变化或 Hit Test 在派发前拒绝动作。
- `failed`：浏览器没能派发动作。

`scroll` 可滚动到视口外控件（按 ref，将目标居中）或翻页（`direction` + 可选 `amount`）；`select` 先按可访问标签、再按精确 value 选择原生 `<select>` 选项，无法匹配时直接失败而非猜测；`hover` 将指针停留在元素上，便于后续观察看到悬停才显示的内容。任何已派发的动作（包括 `scroll`）都会使观察失效，因此每次动作后都要重新观察。

## Operator 导航白名单

> **重要：** `allowedOrigins` 默认不限制顶层 HTTP(S) 导航。用于生产或 QA 时，应由 Operator 配置精确白名单；模型不能修改或传入这个配置。

```yaml
- id: dsh-browser
  name: '@zseven-w/dsh-browser'
  config:
    allowedOrigins:
      - https://staging.example.com
      - http://127.0.0.1:4173
    idleTimeoutMs: 900000
```

白名单会在启动和显式导航前校验，在 Chromium Document Request 层拦截重定向，并在顶层页面变化后再次校验。空数组只允许 `about:blank`。该策略限制顶层文档，不限制白名单页面加载的 CDN / API 子资源。

## 安全与证据边界

- 不相信模型传入的敏感标记，而是根据实时目标语义拒绝删除、付款、发送/发布、安全设置、密码、上传和下载动作。
- Ref 是 HMAC 派生的 opaque 值，只有最新且未过期的一次观察可操作。
- 操作前重新采集语义并核对 fingerprint，再做中心点 Hit Test。
- 自动取消下载，自动关闭 JavaScript Dialog。
- Console 有数量和长度上限，并对常见凭据模式脱敏。
- Network 仅返回 method、status/failure、resource type 和去掉凭据、query、fragment 的 URL，不返回 header 或 body。
- 取消操作会关闭独立 Context，避免已超时动作在后台继续执行。

## 本地开发

需要 Node.js `>=24.11.0`、pnpm，以及已安装的 Google Chrome、Microsoft Edge 或 Chromium。非标准安装位置可由 Operator 设置 `DSH_BROWSER_EXECUTABLE_PATH`。

```sh
pnpm install
pnpm run build
pnpm run typecheck
pnpm test
pnpm run smoke:pack
```

通过 DSH 常规的本地插件流程链接或安装此目录；此版本不会创建远程仓库，也不会发布 registry 包。

## Driver Contract

```ts
import {
  BROWSER_DRIVER_SERVICE, // "zsevenBrowserDriver"
  BROWSER_DRIVER_CONTRACT_VERSION, // 3
  type ZSevenBrowserDriver,
} from '@zseven-w/dsh-browser/driver'
```

服务会声明 `kind: "browser"` 和 `contractVersion: 3`。`visualObserve` 方法只捕获有界 PNG 与 Set-of-Mark 标签（像素 + 框），不做任何理解、OCR 或差异对比。上层插件应通过 Cordis `ctx.inject([BROWSER_DRIVER_SERVICE], ...)` 获取，不应导入 Manager 内部实现，也不能跨 Agent 复用模型 Ref。`disposeScope(ownerId)` 会同时等待迟到的启动并关闭已运行 Session；插件通过结构化 `agent/disposed` 生命周期钩子调用它。

## 已验证范围与限制

本地集成门禁会启动已安装的 Headless Chrome，用两个 Agent Context 访问本地 HTTP Fixture，验证语义输入/点击、陈旧及跨 Agent Ref 拒绝、高风险拒绝、Origin 策略、证据脱敏与临时目录清理。Packed Smoke 会真实 `npm pack`、全新安装，并从安装后的包启动托管浏览器。

当前明确限制：

- 仅支持 Chromium 系浏览器，未实现 Firefox / WebKit。
- 当前是主文档语义 DOM 投影，未实现跨域 iframe 和 closed shadow root 交互。
- `visualObserve` 只做捕获（像素 + Set-of-Mark 标签）；视觉理解由 DSH Harness 的视觉模型完成。
- 不读取现有 Profile、Cookie、扩展或已登录 Tab。
- 已验收路径是 Headless；Headful 参数存在，但尚未获得同等集成覆盖。
- 确定性风险匹配只是拒绝层，不是完整的用户审批系统；上层 QA 工作流仍需自己的授权策略。

## License

MIT
