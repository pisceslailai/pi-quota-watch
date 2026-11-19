# Changelog

## [0.1.3] - 2026-11-19

修复多会话互相覆盖缓存，并让订阅周期取对。

- **修复**：pi-web 一个进程里多个会话各自持有内存快照，刷新时用旧内存覆盖共享缓存，
  会冲掉别的会话刚写入的 `periodEnd` 和响应头采样。现在按块比较时间戳，取更新鲜的一份；
  `after_provider_response` 与用量落盘也走同一套合并
- **修复**：`/rest/subscriptions` 返回多条订阅（含 INACTIVE 的旧周期），改为优先取
  `SUBSCRIPTION_STATUS_ACTIVE`，所以「本期到」现在显示正确的 12/19
- 只写真正拿到的限流字段，避免用 `undefined` 抹掉缓存里的旧值
- 报表与面板标注采样距今多久（如「14:14 · 1h21m 前」），避免过时数据看着像刚采的

## [0.1.2] - 2026-11-19

Grok 侧补上比例：限流余量按 `剩余/上限` 换算成百分比（带进度条），并给出本机用量占比。

- 新增数据源 `grok.com/rest/subscriptions`：拿到套餐显示名、`plan`、`billingPeriodEnd`，
  报表显示「本期到 11/24，月付」（该接口需要浏览器 UA 才能过 Cloudflare）
- Grok 报表改成表格：请求 % / tokens % + 上限 + 采样时间
- 新增「占今日」比例：Grok 今日 tokens / 今日全部 provider tokens；ChatGPT 侧同样给出
- 本地用量缓存从「单日 bucket」升级为「按天历史」，可算近 N 天累计，旧缓存自动迁移
- 状态行只在限流余量 < 99.5% 时才追加百分比，平时仍只显示套餐名
- 实测确认 8300 req / 53.00M tokens 是每分钟级吞吐上限（约 60–85 秒回满），
  因此明确标注「% 是限流余量，不是本期额度」——xAI 没有那种接口

## [0.1.1] - 2026-11-19

状态行瘦身：从 3 个元素（widget 触发片 + 订阅额度按钮 + 长文本）压到 **1 颗可点击胶囊**。

- 摘要文字直接作为 `command:/quota` 状态的文本，点一下就是 `/quota`，不再额外占一个按钮
- 文案缩短（约 38 字符）：`⚠ GPT 5h 61% · 7d 5%（1d4h） | SuperGrok`，
  重置倒计时只在剩余 ≤15% 时出现，Grok 只留套餐名
- Grok 的限流余量从状态行移到 `/quota` 报表
- 常驻明细面板改为**默认关闭**，需要时设 `PI_QUOTA_WIDGET=1`
- `/quota` 报表增加剩余进度条，并补上 ChatGPT 的今日本机用量
- 升级时自动清理旧版本留下的 `quota` 状态项和面板，不会出现两颗胶囊

## [0.1.0] - 2026-11-19

首次发布。

- ChatGPT（`openai-codex`）额度：5h / 7d 窗口剩余百分比、重置倒计时、credits、重置券、可用模型
  （数据源 `chatgpt.com/backend-api/wham/usage`，免费 GET）
- Grok（`xai`）额度：`SuperGrok` 套餐名、Grok Code 权限、被动采集的 `x-ratelimit-*` 余量、今日本机用量
- pi-web：常驻状态行 + 可点击「订阅额度」胶囊（`command:/quota`）+ 「额度明细」widget 面板
- pi TUI：页脚状态行
- `/quota`：强制刷新并在对话里输出 markdown 报表
- 跨会话共享缓存 `~/.pi/agent/quota-watch.json`，45 秒内不重复请求同一个额度接口
- 刷新失败时保留上次成功数据并标注，不清空显示
