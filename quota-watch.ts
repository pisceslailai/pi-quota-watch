/**
 * quota-watch — 在 pi TUI 和 pi-web 里显示 ChatGPT / Grok 订阅额度
 *
 * 数据来源（均为只读查询，不消耗对话额度）：
 *
 *   1. ChatGPT（openai-codex 订阅登录）
 *      GET https://chatgpt.com/backend-api/wham/usage
 *      返回 plan_type、5h / 7d 两个窗口的已用百分比与重置时间、credits、重置券数量。
 *      Codex CLI 自己就是拿这个接口画额度条的，免费 GET、无副作用。
 *
 *   2. Grok（xai 订阅登录）
 *      xAI 没有公开的「订阅剩余额度」接口（/v1/usage、/v1/billing、/v1/quota、
 *      /v1/rate-limits、/v1/subscriptions… 实测全部 404），所以这里拼三个可信来源：
 *        a. after_provider_response 钩子被动采集 api.x.ai 响应头里的
 *           x-ratelimit-remaining-requests / -tokens（真实请求顺带拿到，零成本）
 *        b. https://cli-chat-proxy.grok.com/v1/settings 的 subscription_tier_display
 *           （Grok CLI 后端，给出 SuperGrok 这类套餐名）＋ /v1/user 的 hasGrokCodeAccess
 *        c. 本机用量：message_end 的 usage 累计今天每个 provider 的 token 数
 *
 * 界面：
 *   - pi-web：输入框上方的状态栏常驻一行摘要（status key = `quota`），
 *     外加一个可点击的「订阅额度」胶囊（status key = `command:/quota`，点一下执行 /quota），
 *     widget 面板可展开看逐窗口明细。
 *   - pi TUI：页脚状态 + /quota。
 *
 * 命令：
 *   /quota      强制刷新并输出完整报表
 *
 * 缓存：~/.pi/agent/quota-watch.json（跨会话共享，避免多会话重复打接口）
 *
 * 环境变量：
 *   PI_QUOTA_DISABLE=1          完全禁用
 *   PI_QUOTA_POLL_MS=300000     轮询间隔（最小 30 秒）
 *   PI_QUOTA_DEBUG=1            抓取细节打到 stderr
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/* ------------------------------------------------------------------ 常量 */

const CHATGPT_PROVIDER = "openai-codex";
const XAI_PROVIDER = "xai";

const STATUS_KEY = "quota";
const COMMAND_STATUS_KEY = "command:/quota";
const COMMAND_STATUS_LABEL = "订阅额度";
const WIDGET_KEY = "额度明细";

const CHATGPT_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const XAI_USER_URL = "https://cli-chat-proxy.grok.com/v1/user";
const XAI_TIER_URL = "https://cli-chat-proxy.grok.com/v1/settings";

const CHATGPT_MIN_INTERVAL_MS = 45_000;
const XAI_ACCOUNT_MIN_INTERVAL_MS = 6 * 60 * 60_000;
const DEFAULT_POLL_MS = 5 * 60_000;
const HTTP_TIMEOUT_MS = 15_000;
const USAGE_FLUSH_MS = 5_000;

const LOW_REMAINING_PERCENT = 10;

const DEBUG = process.env.PI_QUOTA_DEBUG === "1";

/* ------------------------------------------------------------------ 类型 */

type QuotaWindow = {
	usedPercent: number;
	windowSeconds?: number;
	resetAt?: number;
	resetAfterSeconds?: number;
};

type ChatgptState = {
	ok: boolean;
	plan?: string;
	primary?: QuotaWindow;
	secondary?: QuotaWindow;
	limitReached?: boolean;
	creditsBalance?: string;
	creditsUnlimited?: boolean;
	resetCredits?: number;
	models?: Record<string, boolean>;
	fetchedAt: number;
	/** 最近一次刷新失败的时间（期间保留上次成功的数值） */
	lastErrorAt?: number;
	error?: string;
};

type XaiState = {
	tier?: string;
	hasGrokCodeAccess?: boolean;
	limitRequests?: number;
	remainingRequests?: number;
	limitTokens?: number;
	remainingTokens?: number;
	/** 响应头采样时间 */
	headersAt?: number;
	/** 套餐 / 权限查询时间 */
	accountAt?: number;
};

type UsageBucket = {
	day: string;
	requests: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
};

type Snapshot = {
	chatgpt?: ChatgptState;
	xai?: XaiState;
	usage?: Record<string, UsageBucket>;
	updatedAt?: number;
};

/* ------------------------------------------------------------- 小工具 */

function num(value: unknown): number | undefined {
	const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	return Number.isFinite(n) ? n : undefined;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function debug(...parts: unknown[]): void {
	if (DEBUG) console.error("[quota-watch]", ...parts);
}

function localDay(ts = Date.now()): string {
	const d = new Date(ts);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fmtClock(ts?: number): string {
	if (!ts || !Number.isFinite(ts)) return "—";
	return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" });
}

function fmtDate(ts?: number): string {
	if (!ts || !Number.isFinite(ts)) return "—";
	const d = new Date(ts);
	return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} ${fmtClock(ts)}`;
}

function fmtDuration(seconds?: number): string {
	if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "—";
	const s = Math.round(seconds);
	const d = Math.floor(s / 86_400);
	const h = Math.floor((s % 86_400) / 3_600);
	const m = Math.floor((s % 3_600) / 60);
	if (d > 0) return `${d}d ${h}h`;
	if (h > 0) return `${h}h ${m}m`;
	return `${m}m`;
}

function fmtTokens(n?: number): string {
	if (n === undefined || !Number.isFinite(n)) return "—";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(Math.round(n));
}

/** filled = 剩余比例 */
function bar(remainingPercent: number, width = 10): string {
	const ratio = Math.max(0, Math.min(1, remainingPercent / 100));
	const filled = Math.round(ratio * width);
	return "█".repeat(filled) + "░".repeat(width - filled);
}

function windowLabel(windowSeconds?: number): string {
	if (!windowSeconds || !Number.isFinite(windowSeconds)) return "—";
	if (windowSeconds >= 86_400) {
		const days = windowSeconds / 86_400;
		return Number.isInteger(days) ? `${days}d` : `${days.toFixed(1)}d`;
	}
	if (windowSeconds >= 3_600) {
		const hours = windowSeconds / 3_600;
		return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
	}
	return `${Math.round(windowSeconds / 60)}m`;
}

function remainingPercent(window: QuotaWindow): number {
	return Math.max(0, 100 - window.usedPercent);
}

function titleCase(value: string): string {
	return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}

function jwtClaim(token: string, claim: string, field: string): string | undefined {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return undefined;
		const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
		const namespace = payload[claim] as Record<string, unknown> | undefined;
		const value = namespace?.[field];
		return typeof value === "string" && value.length > 0 ? value : undefined;
	} catch {
		return undefined;
	}
}

const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";

function accountIdFromToken(token: string): string | undefined {
	return jwtClaim(token, OPENAI_AUTH_CLAIM, "chatgpt_account_id");
}

function planFromToken(token: string): string | undefined {
	return jwtClaim(token, OPENAI_AUTH_CLAIM, "chatgpt_plan_type");
}

/* ------------------------------------------------------------- 缓存 */

function cachePath(): string {
	return join(getAgentDir(), "quota-watch.json");
}

function readCache(): Snapshot {
	try {
		const parsed = JSON.parse(readFileSync(cachePath(), "utf8")) as Snapshot;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function writeCache(snapshot: Snapshot): void {
	try {
		const file = cachePath();
		mkdirSync(dirname(file), { recursive: true });
		const tmp = `${file}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
		renameSync(tmp, file);
	} catch (error) {
		debug("cache write failed", errorMessage(error));
	}
}

/* ------------------------------------------------------- 网络抓取 */

type HttpResult = { status: number; json?: unknown; text: string };

async function getJson(url: string, headers: Record<string, string>): Promise<HttpResult> {
	const response = await fetch(url, { headers, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
	const text = await response.text();
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		json = undefined;
	}
	return { status: response.status, json, text };
}

function pickWindow(raw: unknown): QuotaWindow | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const source = raw as Record<string, unknown>;
	const used = num(source.used_percent);
	if (used === undefined) return undefined;
	return {
		usedPercent: Math.max(0, Math.min(100, used)),
		windowSeconds: num(source.limit_window_seconds),
		resetAt: num(source.reset_at),
		resetAfterSeconds: num(source.reset_after_seconds),
	};
}

function pickModelUsage(raw: unknown): Record<string, boolean> | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const out: Record<string, boolean> = {};
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (value && typeof value === "object" && (value as Record<string, unknown>).available === true) out[key] = true;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 返回 null 表示这个 provider 没有登录；undefined 表示查询被跳过。
 */
async function fetchChatgptQuota(ctx: ExtensionContext): Promise<ChatgptState | null> {
	const token = await ctx.modelRegistry.getApiKeyForProvider(CHATGPT_PROVIDER).catch(() => undefined);
	if (!token) return null;

	const headers: Record<string, string> = {
		Authorization: `Bearer ${token}`,
		Accept: "application/json",
		"User-Agent": "codex_cli_rs/0.60.0 (pi quota-watch)",
	};
	const accountId = accountIdFromToken(token);
	if (accountId) headers["chatgpt-account-id"] = accountId;

	const fetchedAt = Date.now();
	try {
		const { status, json, text } = await getJson(CHATGPT_USAGE_URL, headers);
		if (status !== 200 || !json || typeof json !== "object") {
			return { ok: false, fetchedAt, error: `HTTP ${status}${text ? `: ${text.slice(0, 120)}` : ""}` };
		}
		const body = json as Record<string, any>;
		const rateLimit = (body.rate_limit ?? {}) as Record<string, any>;
		return {
			ok: true,
			fetchedAt,
			plan: typeof body.plan_type === "string" ? body.plan_type : planFromToken(token),
			primary: pickWindow(rateLimit.primary_window),
			secondary: pickWindow(rateLimit.secondary_window),
			limitReached: rateLimit.limit_reached === true || rateLimit.allowed === false,
			creditsBalance: typeof body.credits?.balance === "string" ? body.credits.balance : undefined,
			creditsUnlimited: body.credits?.unlimited === true,
			resetCredits: num(body.rate_limit_reset_credits?.available_count),
			models: pickModelUsage(body.model_usage),
		};
	} catch (error) {
		return { ok: false, fetchedAt, error: errorMessage(error) };
	}
}

/** 返回 null 表示 xai 没有登录。 */
async function fetchXaiAccount(ctx: ExtensionContext): Promise<Partial<XaiState> | null> {
	const token = await ctx.modelRegistry.getApiKeyForProvider(XAI_PROVIDER).catch(() => undefined);
	if (!token) return null;

	const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
	const patch: Partial<XaiState> = { accountAt: Date.now() };

	try {
		const user = await getJson(XAI_USER_URL, headers);
		if (user.status === 200 && user.json && typeof user.json === "object") {
			const body = user.json as Record<string, unknown>;
			if (typeof body.hasGrokCodeAccess === "boolean") patch.hasGrokCodeAccess = body.hasGrokCodeAccess;
		}
	} catch (error) {
		debug("xai user failed", errorMessage(error));
	}

	try {
		const settings = await getJson(XAI_TIER_URL, headers);
		if (settings.status === 200 && settings.json && typeof settings.json === "object") {
			const body = settings.json as Record<string, unknown>;
			const tier = body.subscription_tier_display;
			if (typeof tier === "string" && tier.length > 0) patch.tier = tier;
		}
	} catch (error) {
		debug("xai settings failed", errorMessage(error));
	}

	return patch;
}

/** 从 provider 响应头里收集 xAI 的限流计数（被动，零成本）。 */
function readRateLimitHeaders(rawHeaders: unknown): Partial<XaiState> | undefined {
	if (!rawHeaders || typeof rawHeaders !== "object") return undefined;
	const lower: Record<string, string> = {};
	for (const [key, value] of Object.entries(rawHeaders as Record<string, unknown>)) {
		if (typeof value === "string") lower[key.toLowerCase()] = value;
		else if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
			lower[key.toLowerCase()] = value.join(", ");
		}
	}

	const patch: Partial<XaiState> = {
		limitRequests: num(lower["x-ratelimit-limit-requests"]),
		remainingRequests: num(lower["x-ratelimit-remaining-requests"]),
		limitTokens: num(lower["x-ratelimit-limit-tokens"]),
		remainingTokens: num(lower["x-ratelimit-remaining-tokens"]),
	};

	if (
		patch.limitRequests === undefined &&
		patch.remainingRequests === undefined &&
		patch.limitTokens === undefined &&
		patch.remainingTokens === undefined
	) {
		return undefined;
	}

	patch.headersAt = Date.now();
	return patch;
}

/* ------------------------------------------------------------- 渲染 */

function windowLine(window: QuotaWindow, width = 10): string {
	const remaining = remainingPercent(window);
	const left = windowLabel(window.windowSeconds).padEnd(4, " ");
	const label = `剩${Math.round(remaining)}%`.padStart(4, " ");
	const resetIn = fmtDuration(window.resetAfterSeconds);
	const resetAt = window.resetAt ? fmtDate(window.resetAt * 1000) : undefined;
	const tail = resetAt ? `${resetIn} 后重置 (${resetAt})` : `${resetIn} 后重置`;
	return `  ${left} ${bar(remaining, width)} ${label}   ${tail}`;
}

function usageToday(snapshot: Snapshot, provider: string): UsageBucket | undefined {
	const bucket = snapshot.usage?.[provider];
	if (!bucket || bucket.day !== localDay()) return undefined;
	return bucket;
}

function buildStatus(snapshot: Snapshot): string {
	const parts: string[] = [];

	const chatgpt = snapshot.chatgpt;
	if (chatgpt?.ok && (chatgpt.primary || chatgpt.secondary)) {
		const windows = [chatgpt.primary, chatgpt.secondary].filter(
			(window): window is QuotaWindow => window !== undefined,
		);
		const tightest = windows.reduce(
			(best, window) => (remainingPercent(window) < remainingPercent(best) ? window : best),
			windows[0]!,
		);
		const bits = windows.map(
			(window) => `${windowLabel(window.windowSeconds)} 剩${Math.round(remainingPercent(window))}%`,
		);
		const low = remainingPercent(tightest);
		const warn = chatgpt.limitReached || low <= LOW_REMAINING_PERCENT ? "⚠ " : "";
		const countdown =
			low <= 50 && tightest.resetAfterSeconds !== undefined
				? ` (${fmtDuration(tightest.resetAfterSeconds)} 后重置)`
				: "";
		parts.push(`${warn}GPT ${bits.join(" · ")}${countdown}`);
	} else if (chatgpt && !chatgpt.ok) {
		parts.push("GPT 额度不可用");
	}

	const xai = snapshot.xai;
	const xaiBucket = usageToday(snapshot, XAI_PROVIDER);
	if (xai || xaiBucket) {
		const bits: string[] = [];
		if (xai?.tier) bits.push(xai.tier);
		if (
			xai?.remainingRequests !== undefined &&
			xai.limitRequests !== undefined &&
			xai.limitRequests > 0 &&
			xai.remainingRequests < xai.limitRequests * 0.9
		) {
			bits.push(`限流 ${Math.round(xai.remainingRequests)}/${Math.round(xai.limitRequests)}`);
		}
		if (xaiBucket && xaiBucket.requests > 0) {
			bits.push(`今日 ${fmtTokens(xaiBucket.input + xaiBucket.output)} tok`);
		}
		if (bits.length > 0) parts.push(`Grok ${bits.join(" · ")}`);
	}

	return parts.join("  |  ");
}

function buildPanel(snapshot: Snapshot): string[] {
	const lines: string[] = [];

	const chatgpt = snapshot.chatgpt;
	if (chatgpt) {
		if (chatgpt.ok) {
			const plan = chatgpt.plan ? ` ${titleCase(chatgpt.plan)}` : "";
			const stale =
				chatgpt.lastErrorAt !== undefined ? `（上次刷新失败：${chatgpt.error ?? "unknown"}）` : "";
			const verdict = chatgpt.limitReached ? "  ⚠ 已达上限" : "";
			lines.push(`ChatGPT${plan} · ${fmtClock(chatgpt.fetchedAt)} 更新${verdict}${stale}`);
			if (chatgpt.primary) lines.push(windowLine(chatgpt.primary));
			if (chatgpt.secondary) lines.push(windowLine(chatgpt.secondary));

			const extras: string[] = [];
			if (chatgpt.creditsUnlimited) extras.push("credits 无限");
			else if (chatgpt.creditsBalance !== undefined) extras.push(`credits ${chatgpt.creditsBalance}`);
			if (chatgpt.resetCredits !== undefined) extras.push(`重置券 ${chatgpt.resetCredits}`);
			if (extras.length > 0) lines.push(`  ${extras.join(" · ")}`);

			const chatgptBucket = usageToday(snapshot, CHATGPT_PROVIDER);
			if (chatgptBucket && chatgptBucket.requests > 0) {
				lines.push(
					`  今日    ${chatgptBucket.requests} 次 · 输入 ${fmtTokens(chatgptBucket.input)} · 输出 ${fmtTokens(chatgptBucket.output)} · 缓存读 ${fmtTokens(chatgptBucket.cacheRead)}`,
				);
			}
		} else {
			lines.push(`ChatGPT · 获取失败（${chatgpt.error ?? "unknown"}） · ${fmtClock(chatgpt.fetchedAt)}`);
		}
	}

	const xai = snapshot.xai;
	const xaiBucket = usageToday(snapshot, XAI_PROVIDER);
	if (xai || xaiBucket) {
		const tier = xai?.tier ?? "Grok";
		const access = xai?.hasGrokCodeAccess === true ? " · Grok Code 可用" : "";
		lines.push(`${tier}${access}`);
		if (xai?.remainingRequests !== undefined && xai.limitRequests !== undefined) {
			const remaining = xai.limitRequests > 0 ? (xai.remainingRequests / xai.limitRequests) * 100 : 0;
			lines.push(
				`  限流  ${bar(remaining)} ${Math.round(remaining)}% 剩   ${Math.round(xai.remainingRequests)}/${Math.round(xai.limitRequests)} 请求`,
			);
		}
		if (xai?.remainingTokens !== undefined && xai.limitTokens !== undefined) {
			lines.push(`  tokens 剩 ${fmtTokens(xai.remainingTokens)} / ${fmtTokens(xai.limitTokens)}`);
		}
		if (xai?.headersAt) lines.push(`  （响应头采样 ${fmtClock(xai.headersAt)}，窗口长度未知）`);
		else lines.push("  发一次 Grok 请求后即可看到限流余量");
		if (xaiBucket && xaiBucket.requests > 0) {
			lines.push(
				`  今日    ${xaiBucket.requests} 次 · 输入 ${fmtTokens(xaiBucket.input)} · 输出 ${fmtTokens(xaiBucket.output)} · 缓存读 ${fmtTokens(xaiBucket.cacheRead)}`,
			);
		}
	}

	if (lines.length === 0) return [];
	return [`订阅额度 · ${fmtClock(Date.now())}`, ...lines];
}

function buildReport(snapshot: Snapshot): string {
	const lines: string[] = ["### 订阅额度", ""];

	const chatgpt = snapshot.chatgpt;
	if (chatgpt?.ok) {
		lines.push(`**ChatGPT**${chatgpt.plan ? ` · ${titleCase(chatgpt.plan)}` : ""}　（${fmtClock(chatgpt.fetchedAt)} 更新）`);
		lines.push("");
		lines.push("| 窗口 | 剩余 | 重置 |");
		lines.push("| --- | --- | --- |");
		for (const window of [chatgpt.primary, chatgpt.secondary]) {
			if (!window) continue;
			const resetAt = window.resetAt ? fmtDate(window.resetAt * 1000) : "—";
			lines.push(
				`| ${windowLabel(window.windowSeconds)} | ${Math.round(remainingPercent(window))}% | ${fmtDuration(window.resetAfterSeconds)} 后（${resetAt}） |`,
			);
		}
		lines.push("");
		const extras: string[] = [];
		if (chatgpt.creditsUnlimited) extras.push("credits：无限");
		else if (chatgpt.creditsBalance !== undefined) extras.push(`credits：${chatgpt.creditsBalance}`);
		if (chatgpt.resetCredits !== undefined) extras.push(`重置券：${chatgpt.resetCredits} 张`);
		if (chatgpt.models) extras.push(`可用模型：${Object.keys(chatgpt.models).join(", ")}`);
		if (extras.length > 0) lines.push(extras.join(" · "));
	} else if (chatgpt) {
		lines.push(`**ChatGPT**：获取失败 —— ${chatgpt.error ?? "unknown"}`);
	}

	const xai = snapshot.xai;
	const xaiBucket = usageToday(snapshot, XAI_PROVIDER);
	if (xai || xaiBucket) {
		lines.push("");
		lines.push(`**Grok**${xai?.tier ? ` · ${xai.tier}` : ""}${xai?.hasGrokCodeAccess ? " · Grok Code 可用" : ""}`);
		lines.push("");
		if (xai?.remainingRequests !== undefined && xai.limitRequests !== undefined) {
			lines.push(
				`- 限流余量：${Math.round(xai.remainingRequests)}/${Math.round(xai.limitRequests)} 请求，${fmtTokens(xai.remainingTokens)}/${fmtTokens(xai.limitTokens)} tokens（${fmtClock(xai.headersAt)} 采样，窗口长度未知）`,
			);
		} else {
			lines.push("- 限流余量：暂无数据（用 Grok 发一次请求后自动采集响应头）");
		}
		if (xaiBucket && xaiBucket.requests > 0) {
			lines.push(
				`- 今日本机用量：${xaiBucket.requests} 次请求 · 输入 ${fmtTokens(xaiBucket.input)} · 输出 ${fmtTokens(xaiBucket.output)} · 缓存读 ${fmtTokens(xaiBucket.cacheRead)}`,
			);
		}
		lines.push("- 说明：xAI 没有公开的订阅剩余额度接口，这里给的是限流余量 + 本机用量。");
	}

	if (lines.length <= 2) {
		lines.push("还没有可用的订阅登录：请在 Models 面板登录 OpenAI（ChatGPT Plus/Pro）或 SuperGrok / X Premium。");
	}

	return lines.join("\n");
}

/* ------------------------------------------------------------- 主体 */

export default function quotaWatch(pi: ExtensionAPI) {
	if (process.env.PI_QUOTA_DISABLE === "1") return;

	const pollMs = (() => {
		const raw = Number(process.env.PI_QUOTA_POLL_MS);
		return Number.isFinite(raw) && raw >= 30_000 ? raw : DEFAULT_POLL_MS;
	})();

	let snapshot: Snapshot = readCache();
	let sessionCtx: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let inflight: Promise<void> | undefined;
	let disposed = false;
	let pendingUsage = new Map<string, UsageBucket>();
	let pendingFlush: ReturnType<typeof setTimeout> | undefined;

	const render = (ctx: ExtensionContext): void => {
		if (disposed) return;
		const status = buildStatus(snapshot);
		const panel = buildPanel(snapshot);
		if (status.length === 0 && panel.length === 0) return;
		try {
			ctx.ui.setStatus(STATUS_KEY, status);
			ctx.ui.setStatus(COMMAND_STATUS_KEY, COMMAND_STATUS_LABEL);
			if (panel.length > 0) ctx.ui.setWidget(WIDGET_KEY, panel, { placement: "aboveEditor" });
		} catch (error) {
			debug("render failed", errorMessage(error));
		}
	};

	const clear = (ctx: ExtensionContext | undefined): void => {
		if (!ctx) return;
		try {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			ctx.ui.setStatus(COMMAND_STATUS_KEY, undefined);
			ctx.ui.setWidget(WIDGET_KEY, undefined);
		} catch {
			/* session already gone */
		}
	};

	const flushUsage = (): void => {
		pendingFlush = undefined;
		if (pendingUsage.size === 0) return;

		const latest = readCache();
		const usage: Record<string, UsageBucket> = { ...(latest.usage ?? {}) };
		const today = localDay();
		for (const [provider, delta] of pendingUsage) {
			const current = usage[provider];
			const base: UsageBucket =
				current && current.day === today
					? current
					: { day: today, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
			usage[provider] = {
				day: today,
				requests: base.requests + delta.requests,
				input: base.input + delta.input,
				output: base.output + delta.output,
				cacheRead: base.cacheRead + delta.cacheRead,
				cacheWrite: base.cacheWrite + delta.cacheWrite,
			};
		}
		pendingUsage = new Map();

		snapshot = { ...snapshot, usage, updatedAt: Date.now() };
		writeCache(snapshot);
		if (sessionCtx) render(sessionCtx);
	};

	const scheduleFlush = (): void => {
		if (pendingFlush) return;
		pendingFlush = setTimeout(flushUsage, USAGE_FLUSH_MS);
		pendingFlush.unref?.();
	};

	const recordUsage = (provider: string, usage: Record<string, unknown>): void => {
		const previous = pendingUsage.get(provider);
		pendingUsage.set(provider, {
			day: localDay(),
			requests: (previous?.requests ?? 0) + 1,
			input: (previous?.input ?? 0) + (num(usage.input) ?? 0),
			output: (previous?.output ?? 0) + (num(usage.output) ?? 0),
			cacheRead: (previous?.cacheRead ?? 0) + (num(usage.cacheRead) ?? 0),
			cacheWrite: (previous?.cacheWrite ?? 0) + (num(usage.cacheWrite) ?? 0),
		});
		scheduleFlush();
	};

	const refresh = (ctx: ExtensionContext, options: { force?: boolean } = {}): Promise<void> => {
		if (disposed) return Promise.resolve();
		if (inflight) return inflight;

		inflight = (async () => {
			const now = Date.now();
			snapshot = { ...readCache(), ...snapshot };
			const patch: Partial<Snapshot> = {};

			const chatgptDue =
				options.force === true || !snapshot.chatgpt || now - snapshot.chatgpt.fetchedAt >= CHATGPT_MIN_INTERVAL_MS;
			const xaiDue =
				options.force === true ||
				!snapshot.xai?.accountAt ||
				now - (snapshot.xai.accountAt ?? 0) >= XAI_ACCOUNT_MIN_INTERVAL_MS;

			const tasks: Promise<void>[] = [];

			if (chatgptDue) {
				tasks.push(
					fetchChatgptQuota(ctx)
						.then((state) => {
							if (state === null) {
								// 没登录：清掉旧数据
								patch.chatgpt = undefined;
								return;
							}
							if (state.ok) {
								patch.chatgpt = state;
								debug("chatgpt", state.primary?.usedPercent, state.secondary?.usedPercent);
								return;
							}
							const previous = snapshot.chatgpt;
							if (previous?.ok) {
								// 保留上次成功的数值，只标记刷新失败
								patch.chatgpt = { ...previous, lastErrorAt: Date.now(), error: state.error };
							} else {
								patch.chatgpt = state;
							}
							debug("chatgpt failed", state.error);
						})
						.catch((error) => debug("chatgpt failed", errorMessage(error))),
				);
			}

			if (xaiDue) {
				tasks.push(
					fetchXaiAccount(ctx)
						.then((state) => {
							if (state === null) {
								patch.xai = undefined;
								return;
							}
							if (!state) return;
							patch.xai = { ...(snapshot.xai ?? {}), ...state };
							debug("xai account", state.tier, state.hasGrokCodeAccess);
						})
						.catch((error) => debug("xai account failed", errorMessage(error))),
				);
			}

			if (tasks.length > 0) {
				await Promise.allSettled(tasks);
				if (Object.keys(patch).length > 0) {
					snapshot = { ...snapshot, ...patch, updatedAt: Date.now() };
					writeCache(snapshot);
				}
			}

			render(ctx);
		})()
			.catch((error) => {
				debug("refresh failed", errorMessage(error));
			})
			.finally(() => {
				inflight = undefined;
			});

		return inflight;
	};

	/* --------------------------------------------------------- 事件 */

	pi.on("session_start", async (_event, ctx) => {
		disposed = false;
		sessionCtx = ctx;
		if (timer) clearInterval(timer);
		timer = setInterval(() => {
			if (sessionCtx) void refresh(sessionCtx);
		}, pollMs);
		timer.unref?.();

		render(ctx);
		void refresh(ctx);
	});

	pi.on("session_shutdown", async () => {
		disposed = true;
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		if (pendingFlush) {
			clearTimeout(pendingFlush);
			flushUsage();
		}
		clear(sessionCtx);
		sessionCtx = undefined;
	});

	pi.on("model_select", async (_event, ctx) => {
		sessionCtx = ctx;
		render(ctx);
		void refresh(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		sessionCtx = ctx;
		void refresh(ctx);
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const provider = ctx.model?.provider;
		if (!provider) return;
		const usage = event.message.usage as unknown as Record<string, unknown> | undefined;
		if (!usage) return;
		recordUsage(provider, usage);
	});

	/**
	 * xAI 的限流余量只出现在真实响应头里，这里被动采集（不额外发请求）。
	 * AfterProviderResponseEvent 不带 provider 字段，用当前模型判断。
	 */
	pi.on("after_provider_response", async (event, ctx) => {
		if (ctx.model?.provider !== XAI_PROVIDER) return;
		const patch = readRateLimitHeaders(event.headers);
		if (!patch) return;
		snapshot = { ...snapshot, xai: { ...(snapshot.xai ?? {}), ...patch }, updatedAt: Date.now() };
		writeCache(snapshot);
		render(ctx);
	});

	/* --------------------------------------------------------- 命令 */

	pi.registerCommand("quota", {
		description: "查看 ChatGPT / Grok 订阅额度",
		handler: async (_args, ctx) => {
			sessionCtx = ctx;
			await refresh(ctx, { force: true });
			render(ctx);
			pi.sendMessage(
				{ customType: "quota-report", content: buildReport(snapshot), display: true },
				{ deliverAs: "steer" },
			);
		},
	});
}
