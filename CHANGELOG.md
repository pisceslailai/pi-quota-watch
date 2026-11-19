# Changelog

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
