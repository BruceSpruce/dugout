// Thin HTTP client for API-Football (v3). `fetch` is injectable so tests never touch the network.
// Counts requests against a local budget; /status is free (does not count toward the daily quota).

const BASE = "https://v3.football.api-sports.io";
const FREE_PATHS = new Set(["/status"]);
const MAX_ERROR_TEXT = 300;

export type ApiResult = {
	response: unknown;
	errors: unknown;
	paging?: { current: number; total: number };
	results?: number;
};

export class BudgetExhaustedError extends Error {
	override readonly name = "BudgetExhaustedError";
	constructor(
		readonly maxRequests: number,
		readonly path: string,
	) {
		super(`Request budget (${maxRequests}) exhausted before ${path}`);
	}
}

export class ApiPlanError extends Error {
	override readonly name = "ApiPlanError";
	constructor(
		readonly path: string,
		readonly errorsText: string,
	) {
		super(`${path} -> API errors: ${errorsText}`);
	}
}

export class ApiHttpError extends Error {
	override readonly name = "ApiHttpError";
	constructor(
		readonly path: string,
		readonly status: number,
		readonly bodyText: string,
	) {
		super(`${path} -> HTTP ${status}: ${bodyText}`);
	}
}

export type Client = {
	get(
		path: string,
		params?: Record<string, string | number>,
		opts?: { tolerateApiErrors?: boolean },
	): Promise<ApiResult>;
	readonly spent: number;
	readonly remaining: number | null;
};

export type ClientOptions = {
	apiKey: string;
	fetchImpl?: typeof fetch;
	maxRequests: number;
	/** Minimum gap between counted requests (Free plan has a per-minute limit). Default 0. */
	minIntervalMs?: number;
	/** HTTP 429 (per-minute limit): wait this long, then retry. Default 61 000 ms. */
	rateLimitWaitMs?: number;
	/** Retries after HTTP 429 before giving up with ApiHttpError. Default 3. */
	rateLimitRetries?: number;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
};

const defaultSleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Returns a trimmed JSON text of `errors`, or "" when it is empty (`[]` or `{}`). */
export function errorsText(errors: unknown): string {
	if (!errors) return "";
	if (Array.isArray(errors) && errors.length === 0) return "";
	if (typeof errors === "object" && Object.keys(errors).length === 0) return "";
	return JSON.stringify(errors).slice(0, MAX_ERROR_TEXT);
}

export function createClient(options: ClientOptions): Client {
	const { apiKey, maxRequests } = options;
	const fetchImpl = options.fetchImpl ?? fetch;
	const minIntervalMs = options.minIntervalMs ?? 0;
	const rateLimitWaitMs = options.rateLimitWaitMs ?? 61_000;
	const rateLimitRetries = options.rateLimitRetries ?? 3;
	const sleep = options.sleep ?? defaultSleep;
	const now = options.now ?? Date.now;
	let spent = 0;
	let remaining: number | null = null;
	let lastCountedAt: number | null = null;

	// One HTTP attempt. Counted attempts (everything but /status) respect the budget and pacing;
	// a 429 attempt still counts, because it may consume daily quota.
	async function attempt(url: URL, path: string, free: boolean) {
		if (!free) {
			if (spent >= maxRequests)
				throw new BudgetExhaustedError(maxRequests, path);
			if (lastCountedAt !== null && minIntervalMs > 0) {
				const wait = lastCountedAt + minIntervalMs - now();
				if (wait > 0) await sleep(wait);
			}
			lastCountedAt = now();
			spent++;
		}
		return fetchImpl(url, { headers: { "x-apisports-key": apiKey } });
	}

	async function get(
		path: string,
		params: Record<string, string | number> = {},
		opts: { tolerateApiErrors?: boolean } = {},
	): Promise<ApiResult> {
		const free = FREE_PATHS.has(path);
		const url = new URL(path, BASE);
		for (const [k, v] of Object.entries(params)) {
			url.searchParams.set(k, String(v));
		}
		let res = await attempt(url, path, free);
		for (
			let retry = 0;
			res.status === 429 && retry < rateLimitRetries;
			retry++
		) {
			await sleep(rateLimitWaitMs);
			res = await attempt(url, path, free);
		}
		const header = res.headers.get("x-ratelimit-requests-remaining");
		if (header !== null && header !== "" && Number.isFinite(Number(header))) {
			remaining = Number(header);
		}
		if (!res.ok) {
			throw new ApiHttpError(
				path,
				res.status,
				(await res.text()).slice(0, MAX_ERROR_TEXT),
			);
		}
		const body = (await res.json()) as ApiResult;
		const errText = errorsText(body.errors);
		if (errText && !opts.tolerateApiErrors) {
			throw new ApiPlanError(path, errText);
		}
		return body;
	}

	return {
		get,
		get spent() {
			return spent;
		},
		get remaining() {
			return remaining;
		},
	};
}
