import { describe, expect, it } from "vitest";

import { type LeagueAggregate, leagueRows } from "./leagues";

const agg = (over: Partial<LeagueAggregate>): LeagueAggregate => ({
	competitionSeasonId: 1,
	leagueApiId: 39,
	name: "Premier League",
	country: "England",
	season: 2024,
	clubCount: 20,
	clubsWithSquad: 20,
	...over,
});

describe("leagueRows", () => {
	it("is playable only when every club has a squad", () => {
		const rows = leagueRows([
			agg({ competitionSeasonId: 1 }),
			agg({ competitionSeasonId: 2, clubsWithSquad: 19 }),
			agg({ competitionSeasonId: 3, clubsWithSquad: 0 }),
			agg({ competitionSeasonId: 4, clubCount: 0, clubsWithSquad: 0 }),
		]);
		const by = new Map(rows.map((r) => [r.competitionSeasonId, r.playable]));
		expect(by.get(1)).toBe(true);
		expect(by.get(2)).toBe(false);
		expect(by.get(3)).toBe(false);
		expect(by.get(4)).toBe(false);
	});

	it("orders playable first, then OPEN_LEAGUES order, unknown last by name", () => {
		const rows = leagueRows([
			agg({
				competitionSeasonId: 1,
				leagueApiId: 140,
				name: "La Liga",
				clubsWithSquad: 0,
			}),
			agg({
				competitionSeasonId: 2,
				leagueApiId: 999,
				name: "Zeta",
				clubsWithSquad: 0,
			}),
			agg({
				competitionSeasonId: 3,
				leagueApiId: 40,
				name: "Championship",
				clubsWithSquad: 0,
			}),
			agg({
				competitionSeasonId: 4,
				leagueApiId: 999,
				name: "Alpha",
				clubsWithSquad: 0,
			}),
			agg({ competitionSeasonId: 5, leagueApiId: 78, name: "Bundesliga" }),
		]);
		expect(rows.map((r) => r.competitionSeasonId)).toEqual([5, 3, 1, 4, 2]);
	});

	it("drops the helper fields from the output", () => {
		const [row] = leagueRows([agg({})]);
		expect(row).toEqual({
			competitionSeasonId: 1,
			name: "Premier League",
			country: "England",
			season: 2024,
			clubCount: 20,
			playable: true,
		});
	});
});
