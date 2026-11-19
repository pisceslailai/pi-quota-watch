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

/**
 * 唯一的状态项：key 以 `command:` 开头，pi-web 会把它渲染成可点击胶囊（点一下执行 /quota）。
 * 状态文字本身就是摘要，所以这一颗胶囊同时承担「看数」和「点开」两件事。
 */
const STATUS_KEY = "command:/quota";
/** 旧版本用过的 key，升级后顺手清掉，避免残留。 */
const LEGACY_STATUS_KEYS = ["quota"];
const WIDGET_KEY = "额度明细";
/** 明细面板默认关闭（状态行只留一颗胶囊），设 PI_QUOTA_WIDGET=1 打开。 */
const WIDGET_ENABLED = process.env.PI_QUOTA_WIDGET === "1";

const CHATGPT_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const XAI_USER_URL = "https://cli-chat-proxy.grok.com/v1/user";
const XAI_TIER_URL = "https://cli-chat-proxy.grok.com/v1/settings";
/** grok.com 的订阅接口：套餐名 + 本期账单结束时间（需浏览器 UA 才能过 Cloudflare） */
const GROK_SUBSCRIPTIONS_URL = "https://grok.com/rest/subscriptions";
const BROWSER_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

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
	/** grok.com 返回的计划 id，例如 supergrok */
	plan?: string;
	/** 本期账单结束时间（毫秒） */
	periodEnd?: number;
	billingInterval?: string;
};

type UsageDay = {
	requests: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
};

const EMPTY_USAGE: UsageDay = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

type Snapshot = {
	chatgpt?: ChatgptState;
	xai?: XaiState;
	/** provider → YYYY-MM-DD → 计数 */
	usage?: Record<string, Record<string, UsageDay>>;
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

/** 状态行用的紧凑写法：1d4h / 3h20m / 45m */
function fmtDurationShort(seconds?: number): string {
	if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "—";
	const totalMinutes = Math.floor(seconds / 60);
	const d = Math.floor(totalMinutes / 1_440);
	const h = Math.floor((totalMinutes % 1_440) / 60);
	const m = totalMinutes % 60;
	if (d > 0) return `${d}d${h}h`;
	if (h > 0) return `${h}h${m}m`;
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
		if (!parsed || typeof parsed !== "object") return {};
		parsed.usage = migrateUsage(parsed.usage as unknown);
		return parsed;
	} catch {
		return {};
	}
}

function toUsageDay(raw: Record<string, unknown>): UsageDay {
	return {
		requests: num(raw.requests) ?? 0,
		input: num(raw.input) ?? 0,
		output: num(raw.output) ?? 0,
		cacheRead: num(raw.cacheRead) ?? 0,
		cacheWrite: num(raw.cacheWrite) ?? 0,
	};
}

/** 兼容 v0.1.x 的单日 bucket 格式：{ provider: { day, requests, … } } */
function migrateUsage(raw: unknown): Record<string, Record<string, UsageDay>> | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const out: Record<string, Record<string, UsageDay>> = {};
	for (const [provider, value] of Object.entries(raw as Record<string, unknown>)) {
		if (!value || typeof value !== "object") continue;
		const entry = value as Record<string, unknown>;
		if (typeof entry.day === "string") {
			out[provider] = { [entry.day]: toUsageDay(entry) };
			continue;
		}
		const days: Record<string, UsageDay> = {};
		for (const [day, dayValue] of Object.entries(entry)) {
			if (dayValue && typeof dayValue === "object") days[day] = toUsageDay(dayValue as Record<string, unknown>);
		}
		if (Object.keys(days).length > 0) out[provider] = days;
	}
	return Object.keys(out).length > 0 ? out : undefined;
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

	// grok.com 的订阅信息：套餐显示名 + 本期账单结束时间
	try {
		const subs = await getJson(GROK_SUBSCRIPTIONS_URL, {
			Authorization: `Bearer ${token}`,
			Accept: "application/json",
			Origin: "https://grok.com",
			Referer: "https://grok.com/",
			"User-Agent": BROWSER_UA,
		});
		if (subs.status === 200 && subs.json && typeof subs.json === "object") {
			const body = subs.json as Record<string, any>;
			const display = body.dominantPlan?.surfaceNames?.SURFACE_DISPLAY;
			const plan = body.dominantPlan?.plan;
			if (typeof display === "string" && display.length > 0) patch.tier = display;
			if (typeof plan === "string" && plan.length > 0) patch.plan = plan;

			const first = Array.isArray(body.subscriptions) ? body.subscriptions[0] : undefined;
			const periodEnd = typeof first?.billingPeriodEnd === "string" ? Date.parse(first.billingPeriodEnd) : NaN;
			if (Number.isFinite(periodEnd)) patch.periodEnd = periodEnd;
			const interval = typeof first?.billingInterval === "string" ? first.billingInterval : undefined;
			if (interval) patch.billingInterval = interval.replace(/^BILLING_INTERVAL_/, "").toLowerCase();
		}
	} catch (error) {
		debug("grok subscriptions failed", errorMessage(error));
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

function usageToday(snapshot: Snapshot, provider: string): UsageDay {
	return snapshot.usage?.[provider]?.[localDay()] ?? EMPTY_USAGE;
}

function tokensOf(bucket: UsageDay): number {
	return bucket.input + bucket.output;
}

/** 最近 N 天（含今天）的本机用量 */
function usageRecent(snapshot: Snapshot, provider: string, days: number): { total: UsageDay; dayCount: number } {
	const buckets = snapshot.usage?.[provider];
	if (!buckets) return { total: EMPTY_USAGE, dayCount: 0 };
	const cutoff = localDay(Date.now() - (days - 1) * 86_400_000);
	const total: UsageDay = { ...EMPTY_USAGE };
	let dayCount = 0;
	for (const [day, bucket] of Object.entries(buckets)) {
		if (day < cutoff) continue;
		dayCount += 1;
		total.requests += bucket.requests;
		total.input += bucket.input;
		total.output += bucket.output;
		total.cacheRead += bucket.cacheRead;
		total.cacheWrite += bucket.cacheWrite;
	}
	return { total, dayCount };
}

/** 今日所有 provider 合计 */
function usageTodayTotal(snapshot: Snapshot): UsageDay {
	const total: UsageDay = { ...EMPTY_USAGE };
	for (const bucket of Object.values(snapshot.usage ?? {})) {
		const day = bucket[localDay()];
		if (!day) continue;
		total.requests += day.requests;
		total.input += day.input;
		total.output += day.output;
		total.cacheRead += day.cacheRead;
		total.cacheWrite += day.cacheWrite;
	}
	return total;
}

/** 剩余比例（0–100）；缺数据时 undefined */
function remainingRatio(remaining?: number, limit?: number): number | undefined {
	if (remaining === undefined || limit === undefined || limit <= 0) return undefined;
	return Math.max(0, Math.min(100, (remaining / limit) * 100));
}

function fmtCount(value?: number): string {
	if (value === undefined || !Number.isFinite(value)) return "—";
	return Math.round(value).toLocaleString("en-US");
}

/** part 在 whole 中的百分比，用于「今日占比」 */
function sharePercent(part: number, whole: number): number | undefined {
	if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return undefined;
	return Math.max(0, Math.min(100, (part / whole) * 100));
}

function buildStatus(snapshot: Snapshot): string {
	const parts: string[] = [];

	const chatgpt = snapshot.chatgpt;
	let hasChatgpt = false;
	if (chatgpt?.ok && (chatgpt.primary || chatgpt.secondary)) {
		hasChatgpt = true;
		const windows = [chatgpt.primary, chatgpt.secondary].filter(
			(window): window is QuotaWindow => window !== undefined,
		);
		const tightest = windows.reduce(
			(best, window) => (remainingPercent(window) < remainingPercent(best) ? window : best),
			windows[0]!,
		);
		const low = remainingPercent(tightest);
		const bits = windows.map(
			(window) => `${windowLabel(window.windowSeconds)} ${Math.round(remainingPercent(window))}%`,
		);
		// 只在真的快用完时才占用宽度写重置时间
		const countdown =
			low <= 15 && tightest.resetAfterSeconds !== undefined
				? `（${fmtDurationShort(tightest.resetAfterSeconds)}）`
				: "";
		const warn = chatgpt.limitReached || low <= LOW_REMAINING_PERCENT ? "⚠ " : "";
		parts.push(`${warn}GPT ${bits.join(" · ")}${countdown}`);
	} else if (chatgpt && !chatgpt.ok) {
		parts.push("GPT —");
	}

	const xai = snapshot.xai;
	const xaiBucket = usageToday(snapshot, XAI_PROVIDER);
	if (xai || xaiBucket.requests > 0) {
		const tier = xai?.tier ?? "Grok";
		// 限流余量百分比只在真的掉下来时才上状态行（平时就是 100%，不上比上干净）
		const limitPct = remainingRatio(xai?.remainingTokens, xai?.limitTokens);
		const bits = [limitPct !== undefined && limitPct < 99.5 ? `${tier} ${Math.round(limitPct)}%` : tier];
		// 没有 ChatGPT 数据时多给一点信息
		if (!hasChatgpt && xaiBucket.requests > 0) bits.push(`今日 ${fmtTokens(tokensOf(xaiBucket))}`);
		parts.push(bits.join(" · "));
	}

	return parts.join(" | ");
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
			if (chatgptBucket.requests > 0) {
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
	if (xai || xaiBucket.requests > 0) {
		const tier = xai?.tier ?? "Grok";
		const access = xai?.hasGrokCodeAccess === true ? " · Grok Code 可用" : "";
		const period = xai?.periodEnd ? ` · 本期到 ${fmtDate(xai.periodEnd)}` : "";
		lines.push(`${tier}${access}${period}`);

		const requestPct = remainingRatio(xai?.remainingRequests, xai?.limitRequests);
		const tokenPct = remainingRatio(xai?.remainingTokens, xai?.limitTokens);
		if (requestPct !== undefined) {
			lines.push(`  请求  ${bar(requestPct)} ${Math.round(requestPct)}% 剩   ${fmtCount(xai?.remainingRequests)}/${fmtCount(xai?.limitRequests)}`);
		}
		if (tokenPct !== undefined) {
			lines.push(`  tokens ${bar(tokenPct)} ${Math.round(tokenPct)}% 剩   ${fmtTokens(xai?.remainingTokens)}/${fmtTokens(xai?.limitTokens)}`);
		}
		if (requestPct === undefined && tokenPct === undefined) lines.push("  发一次 Grok 请求后即可看到限流余量");
		else if (xai?.headersAt) lines.push(`  （响应头采样 ${fmtClock(xai.headersAt)}，约 1 分钟滚动）`);

		if (xaiBucket.requests > 0) {
			const total = tokensOf(usageTodayTotal(snapshot));
			const share = sharePercent(tokensOf(xaiBucket), total);
			const shareText = share === undefined ? "" : `（占今日 ${Math.round(share)}%）`;
			lines.push(
				`  今日    ${xaiBucket.requests} 次 · 输入 ${fmtTokens(xaiBucket.input)} · 输出 ${fmtTokens(xaiBucket.output)}${shareText}`,
			);
		}
	}

	if (lines.length === 0) return [];
	return [`订阅额度 · ${fmtClock(Date.now())}`, ...lines];
}

function buildReport(snapshot: Snapshot): string {
	const lines: string[] = ["### 订阅额度", ""];
	const todayTotal = usageTodayTotal(snapshot);

	const chatgpt = snapshot.chatgpt;
	if (chatgpt?.ok) {
		lines.push(`**ChatGPT**${chatgpt.plan ? ` · ${titleCase(chatgpt.plan)}` : ""}　（${fmtClock(chatgpt.fetchedAt)} 更新）`);
		lines.push("");
		lines.push("| 窗口 | 剩余 | 重置 |");
		lines.push("| --- | --- | --- |");
		for (const window of [chatgpt.primary, chatgpt.secondary]) {
			if (!window) continue;
			const remaining = remainingPercent(window);
			const resetAt = window.resetAt ? fmtDate(window.resetAt * 1000) : "—";
			lines.push(
				`| ${windowLabel(window.windowSeconds)} | \`${bar(remaining, 8)}\` ${Math.round(remaining)}% | ${fmtDuration(window.resetAfterSeconds)} 后（${resetAt}） |`,
			);
		}
		lines.push("");
		const extras: string[] = [];
		if (chatgpt.creditsUnlimited) extras.push("credits：无限");
		else if (chatgpt.creditsBalance !== undefined) extras.push(`credits：${chatgpt.creditsBalance}`);
		if (chatgpt.resetCredits !== undefined) extras.push(`重置券：${chatgpt.resetCredits} 张`);
		if (chatgpt.models) extras.push(`可用模型：${Object.keys(chatgpt.models).join(", ")}`);
		if (extras.length > 0) lines.push(extras.join(" · "));
		const chatgptBucket = usageToday(snapshot, CHATGPT_PROVIDER);
		if (chatgptBucket.requests > 0) {
			const share = sharePercent(tokensOf(chatgptBucket), tokensOf(todayTotal));
			const shareText = share === undefined ? "" : `（占今日 ${Math.round(share)}%）`;
			lines.push(
				`今日本机用量：${chatgptBucket.requests} 次 · 输入 ${fmtTokens(chatgptBucket.input)} · 输出 ${fmtTokens(chatgptBucket.output)} · 缓存读 ${fmtTokens(chatgptBucket.cacheRead)} ${shareText}`,
			);
		}
	} else if (chatgpt) {
		lines.push(`**ChatGPT**：获取失败 —— ${chatgpt.error ?? "unknown"}`);
	}

	const xai = snapshot.xai;
	const xaiBucket = usageToday(snapshot, XAI_PROVIDER);
	if (xai || xaiBucket.requests > 0) {
		lines.push("");
		const period = xai?.periodEnd
			? `　（本期到 ${fmtDate(xai.periodEnd)}${xai.billingInterval === "monthly" ? "\uff0c月付" : ""}）`
			: "";
		lines.push(`**Grok**${xai?.tier ? ` · ${xai.tier}` : ""}${xai?.hasGrokCodeAccess ? " · Grok Code 可用" : ""}${period}`);

		const requestPct = remainingRatio(xai?.remainingRequests, xai?.limitRequests);
		const tokenPct = remainingRatio(xai?.remainingTokens, xai?.limitTokens);
		lines.push("");
		if (requestPct !== undefined || tokenPct !== undefined) {
			lines.push("| 维度 | 剩余 | 上限 | 采样 |");
			lines.push("| --- | --- | --- | --- |");
			if (requestPct !== undefined) {
				lines.push(
					`| 请求 | \`${bar(requestPct, 8)}\` ${Math.round(requestPct)}% | ${fmtCount(xai?.limitRequests)} | ${fmtClock(xai?.headersAt)} |`,
				);
			}
			if (tokenPct !== undefined) {
				lines.push(
					`| tokens | \`${bar(tokenPct, 8)}\` ${Math.round(tokenPct)}% | ${fmtTokens(xai?.limitTokens)} | ${fmtClock(xai?.headersAt)} |`,
				);
			}
		} else {
			lines.push("限流余量：暂无数据（用 Grok 发一次请求后自动采集响应头）");
		}

		if (xaiBucket.requests > 0) {
			const share = sharePercent(tokensOf(xaiBucket), tokensOf(todayTotal));
			const shareText = share === undefined ? "" : `（占今日 ${Math.round(share)}%）`;
			lines.push("");
			lines.push(
				`- 今日本机用量：${xaiBucket.requests} 次 · 输入 ${fmtTokens(xaiBucket.input)} · 输出 ${fmtTokens(xaiBucket.output)} · 缓存读 ${fmtTokens(xaiBucket.cacheRead)} ${shareText}`,
			);
			const recent = usageRecent(snapshot, XAI_PROVIDER, 7);
			if (recent.dayCount > 1) {
				lines.push(
					`- 近 ${recent.dayCount} 天本机累计：${recent.total.requests} 次 · ${fmtTokens(tokensOf(recent.total))} tokens`,
				);
			}
		}

		lines.push("");
		lines.push("- ⚠ 上表的 % 是**限流余量**（xAI 只暴露吞吐上限，实测约 1 分钟内回满），不是「本期还剩多少」——xAI 没有这种接口。");
		lines.push("- 能反映实际使用的只有本机统计，所以额外给了「占今日」比例。");
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
	let pendingUsage = new Map<string, UsageDay>();
	let pendingFlush: ReturnType<typeof setTimeout> | undefined;

	const render = (ctx: ExtensionContext): void => {
		if (disposed) return;
		const status = buildStatus(snapshot);
		const panel = WIDGET_ENABLED ? buildPanel(snapshot) : [];
		if (status.length === 0 && panel.length === 0) return;
		try {
			if (status.length > 0) ctx.ui.setStatus(STATUS_KEY, status);
			if (panel.length > 0) ctx.ui.setWidget(WIDGET_KEY, panel, { placement: "aboveEditor" });
		} catch (error) {
			debug("render failed", errorMessage(error));
		}
	};

	const clear = (ctx: ExtensionContext | undefined): void => {
		if (!ctx) return;
		try {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			ctx.ui.setWidget(WIDGET_KEY, undefined);
		} catch {
			/* session already gone */
		}
	};

	const flushUsage = (): void => {
		pendingFlush = undefined;
		if (pendingUsage.size === 0) return;

		const latest = readCache();
		const usage: Record<string, Record<string, UsageDay>> = { ...(latest.usage ?? {}) };
		const today = localDay();
		for (const [provider, delta] of pendingUsage) {
			const days = { ...(usage[provider] ?? {}) };
			const base = days[today] ?? EMPTY_USAGE;
			days[today] = {
				requests: base.requests + delta.requests,
				input: base.input + delta.input,
				output: base.output + delta.output,
				cacheRead: base.cacheRead + delta.cacheRead,
				cacheWrite: base.cacheWrite + delta.cacheWrite,
			};
			usage[provider] = days;
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
		const previous = pendingUsage.get(provider) ?? EMPTY_USAGE;
		pendingUsage.set(provider, {
			requests: previous.requests + 1,
			input: previous.input + (num(usage.input) ?? 0),
			output: previous.output + (num(usage.output) ?? 0),
			cacheRead: previous.cacheRead + (num(usage.cacheRead) ?? 0),
			cacheWrite: previous.cacheWrite + (num(usage.cacheWrite) ?? 0),
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

		// 旧版本（或上一次开启 PI_QUOTA_WIDGET）留下的状态项 / 面板先清掉，避免出现两颗胶囊
		try {
			for (const key of LEGACY_STATUS_KEYS) ctx.ui.setStatus(key, undefined);
			if (!WIDGET_ENABLED) ctx.ui.setWidget(WIDGET_KEY, undefined);
		} catch {
			/* 非交互客户端忽略 */
		}

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
