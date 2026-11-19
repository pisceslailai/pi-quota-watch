# pi-quota-watch

在 **pi**（终端 TUI）和 **pi-web**（浏览器 UI）里显示 ChatGPT / Grok 订阅额度的 pi 插件。

状态行只占 **一颗可点击胶囊**：

```
🔥极限   代理:开   ⚠ GPT 5h 61% · 7d 5%（1d4h） | SuperGrok
```

点它（pi-web）= 执行 `/quota`，弹出完整报表：

```
### 订阅额度

**ChatGPT** · Plus　（15:15 更新）

| 窗口 | 剩余 | 重置 |
| --- | --- | --- |
| 5h | `█████░░░` 61% | 18m 后（11/19 15:34） |
| 7d | `░░░░░░░░` 5% | 1d 4h 后（11/20 20:06） |

credits：0 · 重置券：3 张 · 可用模型：gpt-6-astra

**Grok** · SuperGrok · Grok Code 可用　（本期到 12/19 15:27，月付）

| 维度 | 剩余 | 上限 | 采样 |
| --- | --- | --- | --- |
| 请求 | `████████` 100% | 8,300 | 15:29 |
| tokens | `████████` 100% | 53.00M | 15:29 |

- 今日本机用量：3 次 · 输入 13.0k · 输出 150 · 缓存读 10.2k（占今日 86%）

- ⚠ 上表的 % 是**限流余量**（xAI 只暴露吞吐上限，实测约 1 分钟内回满），不是「本期还剩多少」——xAI 没有这种接口。
- 能反映实际使用的只有本机统计，所以额外给了「占今日」比例。
```

- **ChatGPT（Codex 订阅）**：5 小时 / 7 天窗口的剩余百分比、重置倒计时、credits、重置券
- **Grok（SuperGrok / X Premium）**：套餐名、Grok Code 权限、限流余量、今日本机用量
- 零额外成本：额度查询是免费 GET，限流数据从真实请求的响应头被动采集
- 状态行只在快用完（≤15%）时才写重置倒计时，平时极短

## 它是什么

不是独立程序，是一个 **pi extension**。pi-web 复用同一个 pi 宿主，所以同一个文件同时给终端和浏览器供 UI。做成 pi package 之后可以用 `pi install` 分发。

## 界面

**pi-web**：输入框上方状态行里的一颗按钮，文字就是摘要，点击执行 `/quota`。

```
🔥极限   代理:开   ⚠ GPT 5h 61% · 7d 5%（1d4h） | SuperGrok
```

**pi TUI**：同样的文字在页脚状态行，`/quota` 看完整报表。

想要**常驻的明细面板**（进度条 + credits + 今日用量，不点也能看），打开：

```bash
PI_QUOTA_WIDGET=1
```

```
┌ 额度明细 ────────────────────────────────────────────────────────┐
│ 订阅额度 · 15:15                                                 │
│ ChatGPT Plus · 15:15 更新                                        │
│   5h   █████░░░░░ 剩61%   18m 后重置 (11/19 15:34)                │
│   7d   ░░░░░░░░░░  剩5%   1d 4h 后重置 (11/20 20:06)             │
│   credits 0 · 重置券 3                                           │
│ SuperGrok · Grok Code 可用                                       │
│   限流  ██████████ 100% 剩   8300/8300 请求                      │
│   tokens 剩 53.00M / 53.00M                                      │
└──────────────────────────────────────────────────────────────────┘
```

默认关闭，因为状态行已经和你自己的其它扩展（`🔥极限`、`代理:开`…）挤在一起了。

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

> **同一个插件只能存在一份。** 如果既装了包又留着手动拷贝的
> `~/.pi/agent/extensions/quota-watch.ts`，命令会变成 `/quota:1`、`/quota:2`，
> `/quota` 本身反而失效。二选一。

## 用法

| 操作 | 结果 |
| --- | --- |
| 点状态行胶囊（pi-web）/ `/quota` | 强制刷新 + 在对话里输出报表 |
| 什么都不做 | 会话启动自动渲染，之后每 5 分钟刷新 |

### 环境变量

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `PI_QUOTA_DISABLE` | 未设 | `1` = 完全禁用 |
| `PI_QUOTA_WIDGET` | 未设 | `1` = 额外显示常驻明细面板（默认只有一颗胶囊） |
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

xAI **没有**「本期还剩多少」这种额度接口。实测 404 的路径：
`api.x.ai/v1/{usage,billing,quota,rate-limits,rate_limits,limits,plan,plans,credits,subscription,subscriptions,team,organization,entitlement}`、
`cli-chat-proxy.grok.com/v1/{usage,quota,limits,subscription,billing/usage…}`；
`grok.com/rest/{rate-limits,usage,billing,models}` 全部被 Cloudflare 的 JS 挑战拦掉
（只有 `/rest/subscriptions` 放行）。

所以插件拼四个真实信号：

1. **限流余量百分比**：`api.x.ai` 每次真实响应的头部
   `x-ratelimit-limit-requests` / `-remaining-requests` / `-limit-tokens` / `-remaining-tokens`，
   通过 `after_provider_response` 钩子被动采集（不额外发请求），换算成 `剩余 / 上限` 的百分比。
   **实测这是吞吐上限而不是额度**：连打 4 次小请求，余量在 ~60–85 秒内回满
   （8300 请求 / 53.00M tokens 每分钟级别），所以它几乎总是 100%。
2. **套餐与本周期**：`grok.com/rest/subscriptions`（需要浏览器 UA 才能过 Cloudflare）返回
   `dominantPlan.surfaceNames.SURFACE_DISPLAY`（`SuperGrok`）、`dominantPlan.plan`（`supergrok`）、
   `billingPeriodEnd`、`billingInterval`，所以能显示「本期到 12/19，月付」（列表里有 INACTIVE 的旧周期时取 ACTIVE 那条）。
3. **权限**：`cli-chat-proxy.grok.com/v1/{settings,user}` 的 `subscription_tier_display` 与 `hasGrokCodeAccess`
   （作为 `/rest/subscriptions` 的兜底）。
4. **本机用量比例**：`message_end` 事件里的 `usage` 按天累加（跨会话共享缓存），
   算「今日 Grok 占今日全部用量的百分比」和「近 N 天本机累计」。

**不会**伪造一个"本周还剩 X%"。状态行里的百分比只在限流余量真的掉到 99.5% 以下时才出现，
平时只显示套餐名，避免一个恒定的 100% 占位置。

## 隐私

- 请求只发往 `chatgpt.com`、`api.x.ai`、`cli-chat-proxy.grok.com`，用的是你自己 pi 里已有的凭据
- 没有任何第三方服务器、没有遥测
- 缓存写在本地 `~/.pi/agent/quota-watch.json`（额度快照 + 本机用量计数），可随时删除

## 已知限制

1. **pi-web 的扩展 UI 只有文本**：状态行、文本 widget、对话框、`custom()` 文本组件。
   想做带进度环的卡片得改 pi-web 源码（它是预构建的 Next 应用）。
2. **Grok 没有"本周还剩多少"**：只有每分钟级的吞吐上限（实测 ~1 分钟回满），
   所以报表里给的是「限流余量 %」+「本期本机用量占比」，不是一个额度百分比。
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

It takes exactly **one status slot**: a clickable chip in pi-web whose label is the summary
(`⚠ GPT 5h 61% · 7d 5%（1d4h） | SuperGrok`). Clicking it runs `/quota`, which prints a full markdown
report. Set `PI_QUOTA_WIDGET=1` if you want the always-visible detail panel as well.

- ChatGPT: 5-hour and 7-day windows with remaining percentage, reset countdown, credits and reset-credit count,
  from `GET https://chatgpt.com/backend-api/wham/usage` (the same free endpoint Codex CLI uses).
- Grok: xAI exposes **no** subscription-quota endpoint (30+ probed paths return 404, and
  `grok.com/rest/{rate-limits,usage,billing}` sit behind a Cloudflare JS challenge). The plugin therefore shows
  the real `x-ratelimit-*` headroom from live responses as a percentage, plus the plan and billing period from
  `grok.com/rest/subscriptions`, plus today's local usage share. Measurements show that headroom is a
  **per-minute throughput cap** (refills in ~60–85 s), so the numbers are labelled as rate-limit headroom,
  never as a remaining subscription quota.

```bash
pi install git:github.com/pisceslailai/pi-quota-watch
```

Environment: `PI_QUOTA_DISABLE=1`, `PI_QUOTA_WIDGET=1`, `PI_QUOTA_POLL_MS=300000`, `PI_QUOTA_DEBUG=1`.
