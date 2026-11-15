import { describe, expect, it } from "vitest";

import { BudgetExhaustedError, type Client } from "./client";
import { type QueueEntry, runDaily, statusLine } from "./daily";
import type { FetchSeasonOptions, FetchSeasonResult } from "./fetch";

const queue: QueueEntry[] = [
	{ league: 39, season: 2024, name: "PL", load: true },
	{ league: 140, season: 2024, name: "LaLiga", load: false },
	{ league: 78, season: 2024, name: "BL", load: false },
];
const client = { spent: 0, remaining: null } as unknown as Client;
const now = () => new Date("2026-11-12T00:15:00Z");

// leagues -> result to return; records call order.
function fakeFetch(results: Record<number, FetchSeasonResult | "budget">) {
	const calls: number[] = [];
	const fallback: Record<number, boolean | undefined> = {};
	const fetchSeason = async (o: FetchSeasonOptions) => {
		calls.push(o.league);
		fallback[o.league] = o.fixtureFallback;
		const r = results[o.league];
		if (r === "budget") throw new BudgetExhaustedError(0, "/teams");
		return (
			r ?? { requested: 0, skipped: 0, missingAfter: [], fallbackTeams: 0 }
		);
	};
	return { calls, fallback, fetchSeason };
}
const done = (requested: number): FetchSeasonResult => ({
	requested,
	skipped: 0,
	missingAfter: [],
	fallbackTeams: 0,
});
const partial = (requested: number): FetchSeasonResult => ({
	requested,
	skipped: 0,
	missingAfter: ["players/x.json"],
	fallbackTeams: 0,
});

describe("runDaily", () => {
	it("stops for the day at the first league that is still incomplete", async () => {
		const { calls, fetchSeason } = fakeFetch({ 39: partial(90) });
		const loads: number[] = [];

		const r = await runDaily(
			queue,
			{},
			{
				client,
				dataDir: "/x",
				fetchSeason,
				load: async (e) => {
					loads.push(e.league);
					return 0;
				},
				now,
			},
		);

		expect(calls).toEqual([39]);
		expect(loads).toEqual([]);
		expect(r.state["39-2024"]).toEqual({ complete: false });
	});

	it("loads a playable league once it completes, then moves on to the next league", async () => {
		const { calls, fallback, fetchSeason } = fakeFetch({
			39: done(10),
			140: partial(80),
		});
		const loads: number[] = [];

		const r = await runDaily(
			queue,
			{},
			{
				client,
				dataDir: "/x",
				fetchSeason,
				load: async (e) => {
					loads.push(e.league);
					return 0;
				},
				now,
			},
		);

		expect(calls).toEqual([39, 140]);
		expect(loads).toEqual([39]);
		// The playable league keeps the per-match lineup fallback; archive leagues do not.
		expect(fallback).toEqual({ 39: true, 140: false });
		expect(r.state["39-2024"]).toMatchObject({ complete: true, loadExit: 0 });
		expect(r.state["140-2024"]).toEqual({ complete: false });
	});

	it("skips complete, loaded leagues without fetching and never loads load:false leagues", async () => {
		const { calls, fallback, fetchSeason } = fakeFetch({
			140: done(5),
			78: done(5),
		});
		const loads: number[] = [];
		const state = {
			"39-2024": {
				complete: true,
				loadedAt: "2026-11-11T00:00:00Z",
				loadExit: 0,
			},
		};

		const r = await runDaily(queue, state, {
			client,
			dataDir: "/x",
			fetchSeason,
			load: async (e) => {
				loads.push(e.league);
				return 0;
			},
			now,
		});

		expect(calls).toEqual([140, 78]);
		expect(loads).toEqual([]);
		// Archive (load:false) leagues: squads and teams only, no per-match lineups.
		expect(fallback[140]).toBe(false);
		expect(r.outcomes[0]?.status).toBe("skipped");
	});

	it("retries a failed load on the next run", async () => {
		const { calls, fetchSeason } = fakeFetch({ 39: done(0), 140: partial(1) });
		const loads: number[] = [];
		const state = { "39-2024": { complete: true, loadExit: 1 } };

		await runDaily(queue, state, {
			client,
			dataDir: "/x",
			fetchSeason,
			load: async (e) => {
				loads.push(e.league);
				return 0;
			},
			now,
		});

		expect(calls[0]).toBe(39);
		expect(loads).toEqual([39]);
	});

	it("stops without recording when the budget is already gone", async () => {
		const { calls, fetchSeason } = fakeFetch({ 39: "budget" });

		const r = await runDaily(
			queue,
			{},
			{
				client,
				dataDir: "/x",
				fetchSeason,
				load: async () => 0,
				now,
			},
		);

		expect(calls).toEqual([39]);
		expect(r.state).toEqual({});
	});
});

describe("statusLine", () => {
	it("names the current league and the playable league's load state", () => {
		const line = statusLine(
			queue,
			{ "39-2024": { complete: false } },
			[
				{
					key: "39-2024",
					name: "PL",
					requested: 90,
					missing: 12,
					status: "partial",
				},
			],
			now(),
			90,
		);
		expect(line).toContain("complete 0/3");
		expect(line).toContain("current: PL 2024 (missing 12)");
		expect(line).toContain("PL not loaded yet");
	});
});
