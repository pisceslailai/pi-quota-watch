# Changelog

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
