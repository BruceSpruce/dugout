import { describe, expect, it } from "vitest";

import {
	ApiHttpError,
	ApiPlanError,
	BudgetExhaustedError,
	createClient,
} from "./client";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json", ...init.headers },
		...init,
	});
}

const ok = { get: "x", parameters: {}, errors: [], results: 0, response: [] };

describe("createClient", () => {
	it("sends the key header, builds the query and reads the remaining quota", async () => {
		let seen: { url: string; key: string | null } | undefined;
		const fetchImpl = (async (url: URL, init?: RequestInit) => {
			seen = {
				url: String(url),
				key: new Headers(init?.headers).get("x-apisports-key"),
			};
			return jsonResponse(ok, {
				headers: { "x-ratelimit-requests-remaining": "42" },
			});
		}) as unknown as typeof fetch;
		const client = createClient({ apiKey: "k", fetchImpl, maxRequests: 5 });

		await client.get("/players", { league: 39, season: 2024, page: 2 });

		expect(seen?.url).toBe(
			"https://v3.football.api-sports.io/players?league=39&season=2024&page=2",
		);
		expect(seen?.key).toBe("k");
		expect(client.spent).toBe(1);
		expect(client.remaining).toBe(42);
	});

	it("does not count /status toward the budget", async () => {
		const fetchImpl = (async () => jsonResponse(ok)) as unknown as typeof fetch;
		const client = createClient({ apiKey: "k", fetchImpl, maxRequests: 1 });

		await client.get("/status");
		await client.get("/status");
		await client.get("/teams", { league: 39 });

		expect(client.spent).toBe(1);
	});

	it("throws BudgetExhaustedError without calling the API once the budget is spent", async () => {
		let calls = 0;
		const fetchImpl = (async () => {
			calls++;
			return jsonResponse(ok);
		}) as unknown as typeof fetch;
		const client = createClient({ apiKey: "k", fetchImpl, maxRequests: 1 });

		await client.get("/teams");
		await expect(client.get("/fixtures")).rejects.toBeInstanceOf(
			BudgetExhaustedError,
		);
		expect(calls).toBe(1);
	});

	it("throws ApiPlanError on HTTP 200 with errors.plan, trimming the text", async () => {
		const long = "x".repeat(1000);
		const fetchImpl = (async () =>
			jsonResponse({
				...ok,
				errors: { plan: `Free plans do not have access ${long}` },
			})) as unknown as typeof fetch;
		const client = createClient({ apiKey: "k", fetchImpl, maxRequests: 5 });

		const err = await client.get("/teams").catch((e: unknown) => e);

		expect(err).toBeInstanceOf(ApiPlanError);
		expect((err as ApiPlanError).errorsText.length).toBeLessThanOrEqual(300);
		expect((err as ApiPlanError).errorsText).toContain("plan");
	});

	it("treats an empty errors object like success", async () => {
		const fetchImpl = (async () =>
			jsonResponse({ ...ok, errors: {} })) as unknown as typeof fetch;
		const client = createClient({ apiKey: "k", fetchImpl, maxRequests: 5 });

		await expect(client.get("/teams")).resolves.toBeDefined();
	});

	it("recognises a 403 with errors.token as ApiHttpError", async () => {
		const fetchImpl = (async () =>
			jsonResponse(
				{ ...ok, errors: { token: "Invalid API key" } },
				{ status: 403 },
			)) as unknown as typeof fetch;
		const client = createClient({ apiKey: "bad", fetchImpl, maxRequests: 5 });

		const err = await client.get("/status").catch((e: unknown) => e);

		expect(err).toBeInstanceOf(ApiHttpError);
		expect((err as ApiHttpError).status).toBe(403);
		expect((err as ApiHttpError).message).toContain("Invalid API key");
	});

	it("retries after HTTP 429 (per-minute limit) and counts every attempt", async () => {
		const statuses = [429, 429, 200];
		const waits: number[] = [];
		const fetchImpl = (async () => {
			const status = statuses.shift() ?? 200;
			return status === 429
				? jsonResponse(
						{ ...ok, errors: { rateLimit: "Too many requests" } },
						{ status },
					)
				: jsonResponse(ok);
		}) as unknown as typeof fetch;
		const client = createClient({
			apiKey: "k",
			fetchImpl,
			maxRequests: 5,
			rateLimitWaitMs: 1000,
			sleep: async (ms) => {
				waits.push(ms);
			},
		});

		await expect(client.get("/teams")).resolves.toBeDefined();
		expect(waits).toEqual([1000, 1000]);
		expect(client.spent).toBe(3);
	});

	it("gives up with ApiHttpError 429 after the retry limit", async () => {
		const fetchImpl = (async () =>
			jsonResponse(
				{ ...ok, errors: { rateLimit: "Too many requests" } },
				{ status: 429 },
			)) as unknown as typeof fetch;
		const client = createClient({
			apiKey: "k",
			fetchImpl,
			maxRequests: 10,
			rateLimitRetries: 2,
			sleep: async () => {},
		});

		const err = await client.get("/teams").catch((e: unknown) => e);

		expect(err).toBeInstanceOf(ApiHttpError);
		expect((err as ApiHttpError).status).toBe(429);
		expect(client.spent).toBe(3);
	});

	it("paces counted requests by minIntervalMs but not /status", async () => {
		let clock = 0;
		const waits: number[] = [];
		const fetchImpl = (async () => jsonResponse(ok)) as unknown as typeof fetch;
		const client = createClient({
			apiKey: "k",
			fetchImpl,
			maxRequests: 5,
			minIntervalMs: 6500,
			now: () => clock,
			sleep: async (ms) => {
				waits.push(ms);
				clock += ms;
			},
		});

		await client.get("/status");
		await client.get("/teams");
		clock += 500;
		await client.get("/fixtures");
		await client.get("/status");

		expect(waits).toEqual([6000]);
	});

	it("can tolerate API errors when asked (probe mode)", async () => {
		const fetchImpl = (async () =>
			jsonResponse({
				...ok,
				errors: { plan: "nope" },
			})) as unknown as typeof fetch;
		const client = createClient({ apiKey: "k", fetchImpl, maxRequests: 5 });

		const body = await client.get("/teams", {}, { tolerateApiErrors: true });

		expect(body.errors).toEqual({ plan: "nope" });
	});
});
