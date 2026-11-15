import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createClient } from "./client";
import {
	fetchSeason,
	playerFile,
	teamFixtureFile,
	teamPageFile,
} from "./fetch";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "dugout-fetch-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

type Call = { path: string; team: string | null; page: string | null };

// teams: [team id, number of player pages (paging.total)], in API order.
function fakeApi(
	opts: { teams?: Array<[number, number]>; playersErrors?: unknown } = {},
) {
	const teams = opts.teams ?? [[40, 1]];
	const calls: Call[] = [];
	const fetchImpl = (async (url: URL) => {
		const team = url.searchParams.get("team");
		const page = Number(url.searchParams.get("page") ?? 1);
		calls.push({
			path: url.pathname,
			team,
			page: url.searchParams.get("page"),
		});
		const isPlayers = url.pathname === "/players";
		const errors = isPlayers && opts.playersErrors ? opts.playersErrors : [];
		const response =
			url.pathname === "/teams"
				? teams.map(([id]) => ({ team: { id } }))
				: [{ page }];
		return new Response(
			JSON.stringify({
				get: url.pathname,
				parameters: {},
				errors,
				results: 1,
				paging: {
					current: page,
					total: team
						? (teams.find(([id]) => id === Number(team))?.[1] ?? 1)
						: 1,
				},
				response,
			}),
			{ status: 200 },
		);
	}) as unknown as typeof fetch;
	return { calls, fetchImpl };
}

const label = (c: Call) => (c.team ? `${c.path}#${c.team}/${c.page}` : c.path);

const base = { league: 39, season: 2024 };
const root = () => join(dir, "39", "2024");

describe("fetchSeason", () => {
	it("fetches teams, fixtures, then players team by team using each team's paging.total", async () => {
		const { calls, fetchImpl } = fakeApi({
			teams: [
				[40, 3],
				[33, 2],
				[50, 1],
			],
		});
		const client = createClient({ apiKey: "k", fetchImpl, maxRequests: 50 });

		const r = await fetchSeason({ ...base, dataDir: dir, client });

		expect(r).toEqual({
			requested: 8,
			skipped: 0,
			missingAfter: [],
			fallbackTeams: 0,
		});
		expect(calls.map(label)).toEqual([
			"/teams",
			"/fixtures",
			"/players#40/1",
			"/players#40/2",
			"/players#40/3",
			"/players#33/1",
			"/players#33/2",
			"/players#50/1",
		]);
		expect((await readdir(join(root(), "players"))).sort()).toEqual([
			"team-33-page-001.json",
			"team-33-page-002.json",
			"team-40-page-001.json",
			"team-40-page-002.json",
			"team-40-page-003.json",
			"team-50-page-001.json",
		]);
	});

	it("names team page files with zero-padded page numbers", () => {
		expect(teamPageFile(40, 2)).toBe("players/team-40-page-002.json");
	});

	it("skips existing files, including a team's page 1 whose paging.total drives the rest", async () => {
		await mkdir(join(root(), "players"), { recursive: true });
		await writeFile(
			join(root(), "teams.json"),
			JSON.stringify({
				errors: [],
				response: [{ team: { id: 40 } }, { team: { id: 33 } }],
			}),
		);
		await writeFile(
			join(root(), "players", "team-40-page-001.json"),
			JSON.stringify({ errors: [], paging: { current: 1, total: 2 } }),
		);
		const { calls, fetchImpl } = fakeApi({
			teams: [
				[40, 2],
				[33, 1],
			],
		});
		const client = createClient({ apiKey: "k", fetchImpl, maxRequests: 50 });

		const r = await fetchSeason({ ...base, dataDir: dir, client });

		expect(r).toEqual({
			requested: 3,
			skipped: 2,
			missingAfter: [],
			fallbackTeams: 0,
		});
		expect(calls.map(label)).toEqual([
			"/fixtures",
			"/players#40/2",
			"/players#33/1",
		]);
	});

	it("makes zero quota requests on a second run", async () => {
		const first = fakeApi({
			teams: [
				[40, 2],
				[33, 2],
			],
		});
		await fetchSeason({
			...base,
			dataDir: dir,
			client: createClient({
				apiKey: "k",
				fetchImpl: first.fetchImpl,
				maxRequests: 50,
			}),
		});
		const second = fakeApi({
			teams: [
				[40, 2],
				[33, 2],
			],
		});
		const client = createClient({
			apiKey: "k",
			fetchImpl: second.fetchImpl,
			maxRequests: 50,
		});

		const r = await fetchSeason({ ...base, dataDir: dir, client });

		expect(r).toEqual({
			requested: 0,
			skipped: 6,
			missingAfter: [],
			fallbackTeams: 0,
		});
		expect(second.calls).toHaveLength(0);
	});

	it("stops at the budget mid-team and lists every still-missing file", async () => {
		// teams, fixtures, 40/1, 40/2 fit; 40/3 and all of team 33 do not.
		const { fetchImpl } = fakeApi({
			teams: [
				[40, 3],
				[33, 2],
			],
		});
		const client = createClient({ apiKey: "k", fetchImpl, maxRequests: 4 });

		const r = await fetchSeason({ ...base, dataDir: dir, client });

		expect(r.requested).toBe(4);
		expect(r.missingAfter).toEqual([
			"players/team-40-page-003.json",
			// team 33's page count is unknown, so only its page 1 is listed
			"players/team-33-page-001.json",
		]);
		expect((await readdir(join(root(), "players"))).sort()).toEqual([
			"team-40-page-001.json",
			"team-40-page-002.json",
		]);
	});

	it("lists only teams.json when the budget dies before the team list is known", async () => {
		const { calls, fetchImpl } = fakeApi({ teams: [[40, 2]] });
		const client = createClient({ apiKey: "k", fetchImpl, maxRequests: 0 });

		const r = await fetchSeason({ ...base, dataDir: dir, client });

		expect(r.requested).toBe(0);
		expect(r.missingAfter).toEqual(["teams.json", "fixtures.json"]);
		expect(calls).toHaveLength(0);
	});

	it("writes no player file and rejects when the plan refuses a players page", async () => {
		const { fetchImpl } = fakeApi({
			playersErrors: {
				plan: "Free plans are limited to a maximum value of 3 for the Page parameter",
			},
		});
		const client = createClient({ apiKey: "k", fetchImpl, maxRequests: 50 });

		await expect(
			fetchSeason({ ...base, dataDir: dir, client }),
		).rejects.toThrow(/plan/);
		expect(await readdir(root())).not.toContain("players");
		expect((await readdir(root())).sort()).toEqual([
			"fixtures.json",
			"teams.json",
		]);
	});

	it("leaves no temp files behind", async () => {
		const { fetchImpl } = fakeApi({ teams: [[40, 2]] });
		const client = createClient({ apiKey: "k", fetchImpl, maxRequests: 50 });

		await fetchSeason({ ...base, dataDir: dir, client });

		const all = [
			...(await readdir(root())),
			...(await readdir(join(root(), "players"))),
		];
		expect(all.some((f) => f.endsWith(".tmp"))).toBe(false);
	});

	it("exposes file names for fixture lineups and single players", () => {
		expect(teamFixtureFile(33, 7)).toBe("players/team-33-fixture-7.json");
		expect(playerFile(901)).toBe("players/player-901.json");
	});
});

// Team 33 has 4 player pages (ids 1,2 / 3,4 / 5,6 / 7,8). Its fixtures 100 (home) and 101 (away)
// field players 1..5 and 9, 10; fixture 102 is team 40 only. Pages 1..3 hold ids 1..6.
function fallbackApi(opts: { rowMinutes?: number } = {}) {
	const calls: string[] = [];
	const json = (get: string, response: unknown, total = 1) =>
		new Response(
			JSON.stringify({
				get,
				parameters: {},
				errors: [],
				results: 1,
				paging: { current: 1, total },
				response,
			}),
			{ status: 200 },
		);
	const fetchImpl = (async (url: URL) => {
		const q = url.searchParams;
		calls.push(
			`${url.pathname}?${[...q.keys()]
				.sort()
				.map((k) => `${k}=${q.get(k)}`)
				.join("&")}`,
		);
		if (url.pathname === "/teams")
			return json("teams", [{ team: { id: 33 } }, { team: { id: 40 } }]);
		if (url.pathname === "/fixtures")
			return json("fixtures", [
				{ fixture: { id: 100 }, teams: { home: { id: 33 }, away: { id: 40 } } },
				{ fixture: { id: 101 }, teams: { home: { id: 40 }, away: { id: 33 } } },
				{ fixture: { id: 102 }, teams: { home: { id: 40 }, away: { id: 50 } } },
			]);
		if (url.pathname === "/fixtures/players") {
			const ids = q.get("fixture") === "100" ? [1, 2, 9] : [3, 5, 10];
			return json("fixtures/players", [
				{
					team: { id: Number(q.get("team")) },
					players: ids.map((id) => ({ player: { id } })),
				},
			]);
		}
		if (q.get("id"))
			return json("players", [
				{ player: { id: Number(q.get("id")) }, statistics: [] },
			]);
		const team = Number(q.get("team"));
		const page = Number(q.get("page") ?? 1);
		if (team === 33 && page > 3)
			throw new Error("page above plan limit requested");
		const stats = (tid: number) =>
			opts.rowMinutes === undefined
				? []
				: [
						{
							team: { id: tid },
							league: { id: 39 },
							games: { minutes: opts.rowMinutes },
						},
					];
		const response =
			team === 33
				? [
						{ player: { id: page * 2 - 1 }, statistics: stats(33) },
						{ player: { id: page * 2 }, statistics: stats(33) },
					]
				: [{ player: { id: 500 }, statistics: stats(40) }];
		return json("players", response, team === 33 ? 4 : 1);
	}) as unknown as typeof fetch;
	return { calls, fetchImpl };
}

describe("fetchSeason fallback for teams above maxPage", () => {
	it("fetches fixtures' lineups, then only players absent from pages 1..maxPage", async () => {
		const { calls, fetchImpl } = fallbackApi();
		const client = createClient({ apiKey: "k", fetchImpl, maxRequests: 100 });

		const r = await fetchSeason({ ...base, dataDir: dir, client });

		expect(r.fallbackTeams).toBe(1);
		expect(r.missingAfter).toEqual([]);
		expect(
			calls.filter((c) => c.startsWith("/players?") && c.includes("team=33")),
		).toHaveLength(3);
		expect(calls.filter((c) => c.startsWith("/fixtures/players"))).toEqual([
			"/fixtures/players?fixture=100&team=33",
			"/fixtures/players?fixture=101&team=33",
		]);
		// ids on pages (1..6) are not requested; 9 and 10 are, ascending
		expect(calls.filter((c) => c.includes("id="))).toEqual([
			"/players?id=9&league=39&season=2024",
			"/players?id=10&league=39&season=2024",
		]);
		const files = await readdir(join(root(), "players"));
		expect(files).toContain("player-9.json");
		expect(files).toContain("team-33-fixture-100.json");
		expect(files).not.toContain("team-33-page-004.json");
		expect(files).not.toContain("team-40-fixture-102.json");
	});

	it("with fixtureFallback off fetches squads only: no lineups, no single players, complete", async () => {
		const { calls, fetchImpl } = fallbackApi();
		const client = createClient({ apiKey: "k", fetchImpl, maxRequests: 100 });

		const r = await fetchSeason({
			...base,
			dataDir: dir,
			client,
			fixtureFallback: false,
		});

		expect(r.fallbackTeams).toBe(0);
		expect(r.missingAfter).toEqual([]);
		expect(
			calls.filter((c) => c.startsWith("/players?") && c.includes("team=33")),
		).toHaveLength(3);
		expect(
			calls.some((c) => c.startsWith("/fixtures/players") || c.includes("id=")),
		).toBe(false);
	});

	it("does not request player files until all fixture files exist, then completes, then makes no requests", async () => {
		const first = fallbackApi();
		// teams, fixtures, 33/1..3, then only fixture 100 fits
		const c1 = createClient({
			apiKey: "k",
			fetchImpl: first.fetchImpl,
			maxRequests: 6,
		});
		const r1 = await fetchSeason({ ...base, dataDir: dir, client: c1 });
		expect(r1.missingAfter).toEqual([
			"players/team-33-fixture-101.json",
			"players/team-40-page-001.json",
		]);
		expect(first.calls.some((c) => c.includes("id="))).toBe(false);

		const second = fallbackApi();
		const c2 = createClient({
			apiKey: "k",
			fetchImpl: second.fetchImpl,
			maxRequests: 100,
		});
		const r2 = await fetchSeason({ ...base, dataDir: dir, client: c2 });
		expect(r2.missingAfter).toEqual([]);
		expect(second.calls.filter((c) => c.includes("id="))).toHaveLength(2);

		const third = fallbackApi();
		const c3 = createClient({
			apiKey: "k",
			fetchImpl: third.fetchImpl,
			maxRequests: 100,
		});
		const r3 = await fetchSeason({ ...base, dataDir: dir, client: c3 });
		expect(r3.requested).toBe(0);
		expect(third.calls).toHaveLength(0);
	});

	it("raises the cap with maxPage and then needs no fallback", async () => {
		const { calls, fetchImpl } = fallbackApi();
		const client = createClient({ apiKey: "k", fetchImpl, maxRequests: 100 });

		// the fake throws for team 33 page > 3, so allow it via a wrapper
		const wrapped = (async (url: URL) => {
			if (
				url.pathname === "/players" &&
				url.searchParams.get("team") === "33" &&
				url.searchParams.get("page") === "4"
			)
				return new Response(
					JSON.stringify({
						errors: [],
						paging: { current: 4, total: 4 },
						response: [{ player: { id: 7 } }, { player: { id: 8 } }],
					}),
					{ status: 200 },
				);
			return fetchImpl(url);
		}) as unknown as typeof fetch;
		const r = await fetchSeason({
			...base,
			dataDir: dir,
			client: createClient({
				apiKey: "k",
				fetchImpl: wrapped,
				maxRequests: 100,
			}),
			maxPage: 4,
		});

		expect(client.spent).toBe(0);
		expect(
			calls.some((c) => c.startsWith("/fixtures/players") || c.includes("id=")),
		).toBe(false);
		expect(r.fallbackTeams).toBe(0);
		expect(await readdir(join(root(), "players"))).toContain(
			"team-33-page-004.json",
		);
	});

	it("skips the fallback when pages 1..maxPage already cover the team's league minutes", async () => {
		// Team 33 plays 2 fixtures → expected 2 × 11 × 90 = 1980 minutes; 6 rows × 330 = 1980.
		const { calls, fetchImpl } = fallbackApi({ rowMinutes: 330 });
		const client = createClient({ apiKey: "k", fetchImpl, maxRequests: 100 });

		const r = await fetchSeason({ ...base, dataDir: dir, client });

		expect(r.fallbackTeams).toBe(0);
		expect(
			calls.some((c) => c.startsWith("/fixtures/players") || c.includes("id=")),
		).toBe(false);
	});

	it("still runs the fallback when minutes on pages 1..maxPage fall short", async () => {
		// 6 rows × 300 = 1800 < 0.95 × 1980 = 1881
		const { calls, fetchImpl } = fallbackApi({ rowMinutes: 300 });
		const client = createClient({ apiKey: "k", fetchImpl, maxRequests: 100 });

		const r = await fetchSeason({ ...base, dataDir: dir, client });

		expect(r.fallbackTeams).toBe(1);
		expect(calls.filter((c) => c.startsWith("/fixtures/players"))).toHaveLength(
			2,
		);
	});
});
