# pi-quota-watch

在 **pi**（终端 TUI）和 **pi-web**（浏览器 UI）里显示 ChatGPT / Grok 订阅额度的 pi 插件。

```
⚠ GPT 5h 剩76% · 7d 剩9% (1d 5h 后重置)  |  Grok SuperGrok · 今日 6.6k tok   [订阅额度]
```

- **ChatGPT（Codex 订阅）**：5 小时窗口 / 7 天窗口的剩余百分比、重置倒计时、credits、重置券数量
- **Grok（SuperGrok / X Premium）**：套餐名、Grok Code 权限、限流余量、今日本机用量
- 零额外成本：额度查询是免费 GET，限流数据从真实请求的响应头被动采集
- pi-web 里额外提供可点击胶囊（点一下执行 `/quota`）和可展开的明细面板

## 它是什么

不是独立程序，是一个 **pi extension**。pi-web 复用同一个 pi 宿主，所以同一个文件同时给终端和浏览器供 UI。做成 pi package 之后可以用 `pi install` 分发。

## 界面

**pi-web**（输入框上方状态行 + 面板）

```
⚠ GPT 5h 剩76% · 7d 剩9% (1d 5h 后重置)  |  Grok SuperGrok · 今日 6.6k tok   订阅额度 ▸
┌ 额度明细 ────────────────────────────────────────────────────────┐
│ 订阅额度 · 14:18                                                 │
│ ChatGPT Plus · 14:17 更新                                        │
│   5h   ████████░░ 剩76%   1h 16m 后重置 (11/19 15:34)             │
│   7d   █░░░░░░░░░  剩9%   1d 5h 后重置 (11/20 20:06)             │
│   credits 0 · 重置券 3                                           │
│   今日    6 次 · 输入 812k · 输出 21k · 缓存读 640k               │
│ SuperGrok · Grok Code 可用                                       │
│   限流  ██████████ 100% 剩   8300/8300 请求                      │
│   tokens 剩 53.00M / 53.00M                                      │
│   今日    2 次 · 输入 6.5k · 输出 96 · 缓存读 9.0k                │
└──────────────────────────────────────────────────────────────────┘
```

**pi TUI**：同样的内容在页脚状态行，`/quota` 看完整报表。

`/quota` 会在对话里输出 markdown 报表：

```
### 订阅额度

**ChatGPT** · Plus　（14:39 更新）

| 窗口 | 剩余 | 重置 |
| --- | --- | --- |
| 5h | 69% | 55m 后（11/19 15:34） |
| 7d | 6% | 1d 5h 后（11/20 20:06） |

credits：0 · 重置券：3 张 · 可用模型：gpt-6-astra

**Grok** · SuperGrok · Grok Code 可用

- 限流余量：8300/8300 请求，53.00M/53.00M tokens（14:14 采样，窗口长度未知）
- 今日本机用量：2 次请求 · 输入 6.5k · 输出 96 · 缓存读 9.0k
- 说明：xAI 没有公开的订阅剩余额度接口，这里给的是限流余量 + 本机用量。
```

## 安装

```bash
# 从 GitHub（推荐）
pi install git:github.com/pisceslailai/pi-quota-watch

# 只试用一次，不写进 settings.json
pi -e git:github.com/pisceslailai/pi-quota-watch

# 本地开发目录
pi install ./pi-quota-watch
```

也可以手动把 `quota-watch.ts` 丢进 `~/.pi/agent/extensions/`（全局生效，不用装包）。

安装后**重启 pi-web**（`pi-web stop` 再 `pi-web`），或在会话里执行 `/reload`。

> 同一个插件只能存在一份：如果既装了包又留着手动拷贝的 `~/.pi/agent/extensions/quota-watch.ts`，
> 命令会变成 `/quota:1`、`/quota:2`，`/quota` 本身反而失效。二选一。

## 用法

| 操作 | 结果 |
| --- | --- |
| `/quota` | 强制刷新 + 在对话里输出报表 |
| 点状态行上的「订阅额度」胶囊（pi-web） | 等于执行 `/quota` |
| 什么都不做 | 会话启动自动渲染，之后每 5 分钟刷新 |

### 环境变量

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `PI_QUOTA_DISABLE` | 未设 | `1` = 完全禁用 |
| `PI_QUOTA_POLL_MS` | `300000` | 轮询间隔，最小 30000 |
| `PI_QUOTA_DEBUG` | 未设 | `1` = 抓取细节打到 stderr |

## 数据从哪来

### ChatGPT（`openai-codex` 登录）

```http
GET https://chatgpt.com/backend-api/wham/usage
Authorization: Bearer <OAuth access token>
chatgpt-account-id: <JWT 里 https://api.openai.com/auth 的 chatgpt_account_id>
```

返回 `plan_type`、`rate_limit.primary_window`（5h）/ `.secondary_window`（7d）的
`used_percent`、`reset_at`、`reset_after_seconds`，以及 `credits`、`rate_limit_reset_credits`、
`model_usage`。Codex CLI 画额度条用的就是它，**免费 GET，不消耗对话额度**。

Token 通过 `ctx.modelRegistry.getApiKeyForProvider("openai-codex")` 拿，OAuth 刷新与落盘由 pi 负责，
插件不碰 `auth.json`。

### Grok（`xai` 登录）

xAI **没有**公开的订阅剩余额度接口。实测 404 的路径：
`api.x.ai/v1/{usage,billing,quota,rate-limits,rate_limits,limits,plan,plans,credits,subscription,subscriptions,team,organization,entitlement}`、
`cli-chat-proxy.grok.com/v1/{usage,quota,limits,subscription,billing/usage…}`；
`grok.com/rest/rate-limits` 被 Cloudflare 拦。

所以插件拼三个真实信号：

1. **限流余量**：`api.x.ai` 每次真实响应的头部
   `x-ratelimit-limit-requests` / `-remaining-requests` / `-limit-tokens` / `-remaining-tokens`，
   通过 `after_provider_response` 钩子被动采集（不额外发请求）。
2. **套餐与权限**：`cli-chat-proxy.grok.com/v1/settings` 的 `subscription_tier_display`（如 `SuperGrok`）
   和 `/v1/user` 的 `hasGrokCodeAccess`。
3. **今日本机用量**：`message_end` 事件里的 `usage` 按天累加（跨会话共享缓存）。

**不会**伪造一个"本周还剩 X%"。

## 隐私

- 请求只发往 `chatgpt.com`、`api.x.ai`、`cli-chat-proxy.grok.com`，用的是你自己 pi 里已有的凭据
- 没有任何第三方服务器、没有遥测
- 缓存写在本地 `~/.pi/agent/quota-watch.json`（额度快照 + 本机用量计数），可随时删除

## 已知限制

1. **pi-web 的扩展 UI 只有文本**：状态行、文本 widget、对话框、`custom()` 文本组件。
   想做带进度环的卡片得改 pi-web 源码（它是预构建的 Next 应用）。
2. **Grok 没有"本周还剩多少"**：限流窗口很短，计数器会很快回满，只能当瞬时余量看。
3. 需要能访问上述域名；走 `HTTP_PROXY` / `HTTPS_PROXY`（pi 自带的 dispatcher 会处理）。
4. 额度查询失败时保留上次成功的数值并标注「上次刷新失败」，不会清空显示。

## 开发

```bash
npm install        # 只为类型检查（host 包在 peerDependencies 里）
npm run typecheck
```

文件结构就是一个 extension：`quota-watch.ts` 默认导出一个 `(pi: ExtensionAPI) => void` 工厂。

## License

MIT

---

## English

**pi-quota-watch** is a [pi](https://github.com/earendil-works/pi) extension / pi package that shows your
ChatGPT (Codex subscription) and Grok (SuperGrok / X Premium) quota inside **pi** and **pi-web**.

- ChatGPT: 5-hour and 7-day windows with remaining percentage, reset countdown, credits and reset-credit count,
  from `GET https://chatgpt.com/backend-api/wham/usage` (the same free endpoint Codex CLI uses).
- Grok: xAI exposes **no** subscription-quota endpoint (30+ probed paths return 404), so the panel shows
  passive `x-ratelimit-*` headroom collected from real responses, the plan name from the Grok CLI backend,
  and today's local token usage. No invented percentages.
- Renders as a status line, an expandable text widget and a clickable `/quota` chip in pi-web;
  the same data shows in the terminal footer.

```bash
pi install git:github.com/pisceslailai/pi-quota-watch
```

Environment: `PI_QUOTA_DISABLE=1`, `PI_QUOTA_POLL_MS=300000`, `PI_QUOTA_DEBUG=1`.
