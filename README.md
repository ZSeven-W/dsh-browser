# dsh-browser

English · [简体中文](README.zh.md)

Headless-first managed Browser Use for DeepSeek Harness. Each Agent gets its own temporary Chrome/Edge/Chromium user-data directory, short-lived semantic references, deterministic high-risk rejection, and bounded evidence.

Current version: `0.1.0-rc.1`. This checkout is local development work and has not been published to npm.

## Why this shape

`dsh-browser` does not attach to your personal browser or expose CSS selectors to the model. A tool call is always scoped by `exec.agent.id`; an Agent can only observe and act in the browser context it owns.

```text
Agent A ── ephemeral Chromium context A ── opaque refs A
Agent B ── ephemeral Chromium context B ── opaque refs B
                                   └──── bounded console/network evidence
```

The exported `zsevenBrowserDriver` service is the stable orchestration surface intended for `dsh-qa`.

## Tools

| Tool | Purpose |
| --- | --- |
| `browser_session_start` | Discover installed Chrome/Edge/Chromium and start one isolated context. |
| `browser_observe` | Return a bounded semantic view with opaque epoch/fingerprint/expiry-bound refs. |
| `browser_act` | `click`, `fill`, `press`, `navigate`, `scroll`, `select`, or `hover` after live re-resolution and target checks. |
| `browser_evidence` | Return bounded, redacted console and network metadata. |
| `browser_session_stop` | Close the context and delete its exact temporary profile directory. |

Every `browser_act` result is a receipt with one of four states:

- `confirmed`: the browser completed the validated dispatch. This does **not** claim the application's business outcome succeeded.
- `unknown`: dispatch may have happened, but cancellation/navigation/runtime failure made the resulting page state uncertain.
- `rejected`: policy, stale-ref, semantic-change, expiry, or hit-test checks stopped dispatch.
- `failed`: the browser could not dispatch the action.

`scroll` reaches off-viewport controls (by ref, centering the target) or pages the viewport (`direction` + optional `amount`); `select` chooses a native `<select>` option by accessible label first and exact value second, failing rather than guessing; `hover` holds the pointer over an element so a later observe sees hover-revealed content. Any dispatched action — including `scroll` — invalidates the observation, so observe again after acting.

## Operator navigation policy

> **Important:** `allowedOrigins` defaults to unrestricted top-level HTTP(S) navigation. Production and QA profiles should set an exact allowlist owned by the operator. It is never a model argument.

Example profile row:

```yaml
- id: dsh-browser
  name: '@zseven-w/dsh-browser'
  config:
    allowedOrigins:
      - https://staging.example.com
      - http://127.0.0.1:4173
    idleTimeoutMs: 900000
```

The allowlist is enforced before start/navigation, at Chromium's document-request interception layer for redirects, and after top-level page changes. An empty list allows only `about:blank`. It constrains top-level documents, not CDN/API subresources loaded by an allowed page.

## Safety and evidence boundaries

- Live target semantics—not a model-provided “sensitive” flag—reject destructive, financial, send/publish, security-change, password, upload, and download actions.
- Refs are opaque HMAC-derived values and only the latest unexpired observation is actionable.
- The driver re-collects live semantics and requires the same fingerprint, then center-point hit-tests before target actions.
- Downloads are cancelled and JavaScript dialogs are dismissed.
- Console text is bounded and common credential patterns are redacted.
- Network evidence contains method, status/failure, resource type, and a URL without credentials/query/fragment; it never includes headers or bodies.
- Cancellation closes the isolated browser context so a timed-out action cannot continue behind a newer action.

## Develop locally

Requirements: Node.js `>=24.11.0`, pnpm, and an installed Google Chrome, Microsoft Edge, or Chromium. `DSH_BROWSER_EXECUTABLE_PATH` is an operator-only override for a non-standard executable location.

```sh
pnpm install
pnpm run build
pnpm run typecheck
pnpm test
pnpm run smoke:pack
```

Link or install this directory through the normal DSH local-plugin workflow; no remote repository or registry package is created by this checkout.

## Exported driver contract

```ts
import {
  BROWSER_DRIVER_SERVICE, // "zsevenBrowserDriver"
  BROWSER_DRIVER_CONTRACT_VERSION, // 3
  type ZSevenBrowserDriver,
} from '@zseven-w/dsh-browser/driver'
```

The service advertises `kind: "browser"` and `contractVersion: 4`. Its `visualObserve` method captures a bounded PNG plus Set-of-Mark labels for the latest observation; it returns pixels and boxes only — no understanding, OCR, or diffing. Consumers should obtain it with Cordis injection (`ctx.inject([BROWSER_DRIVER_SERVICE], ...)`) and must not import manager internals or share model refs between Agents. `disposeScope(ownerId)` drains a late start as well as an active session; the plugin invokes it from the structural `agent/disposed` lifecycle hook.

## Verified scope and current limitations

The local integration gate starts installed Chrome headlessly, runs two isolated Agent contexts against a local HTTP fixture, verifies semantic fill/click, stale and cross-Agent ref rejection, deterministic dangerous-action rejection, origin policy, evidence redaction, and temporary-profile cleanup. The packed smoke performs a real clean npm install and starts the installed package's managed browser.

Initial limitations are intentional and should not be read as claims:

- Chromium-family browsers only; Firefox and WebKit are not implemented.
- Main-document semantic DOM projection; cross-origin iframe and closed-shadow-root interaction are not implemented.
- `visualObserve` performs capture only (pixels + Set-of-Mark labels); visual understanding is delegated to the DSH harness vision model.
- No existing-profile, cookie, extension, or signed-in-tab borrowing.
- Headless mode is the accepted path; the available headful option has not received the same integration coverage.
- Risk matching is a deterministic deny layer, not a complete user-approval system. Higher-level QA workflows still need their own authorization policy.

## License

MIT
