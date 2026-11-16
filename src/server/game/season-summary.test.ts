import { describe, expect, it } from "vitest";

import type { FixtureResult } from "~/engine/club-strength";
import { completedSeasons, gameHistory, seasonSummary } from "./season-summary";

// 4 clubs, single round robin; club 1 (Delta) is the player.
const clubs = [
	{ clubId: 1, name: "Delta" },
	{ clubId: 2, name: "Alfa" },
	{ clubId: 3, name: "Charlie" },
	{ clubId: 4, name: "Bravo" },
];
const r = (h: number, a: number, hg: number, ag: number): FixtureResult => ({
	homeClubId: h,
	awayClubId: a,
	homeGoals: hg,
	awayGoals: ag,
});

// Season 1: Bravo 5 (W1 D2 L0, 6:3), Delta 4 (W1 D1 L1, 4:3), Charlie 4 (2:2), Alfa 3 (1:5).
const season1 = [
	r(1, 2, 2, 0),
	r(3, 4, 1, 1),
	r(1, 3, 0, 1),
	r(4, 2, 3, 0),
	r(1, 4, 2, 2),
	r(2, 3, 1, 0),
];
// Season 2: Delta 5 (W1 D2, 8:7), Bravo 4 (4:3), Alfa 4 (5:5), Charlie 2 (1:3).
const season2 = [
	r(1, 2, 5, 4),
	r(3, 4, 0, 2),
	r(1, 3, 1, 1),
	r(4, 2, 0, 1),
	r(1, 4, 2, 2),
	r(2, 3, 0, 0),
];

describe("seasonSummary", () => {
	it("table with W/D/L and goals against, champion, user line, stats", () => {
		const s = seasonSummary({
			seasonNo: 1,
			clubs,
			results: season1,
			userClubId: 1,
		});
		expect(s.seasonNo).toBe(1);
		expect(s.champion).toBe("Bravo");
		expect(
			s.table.map((t) => [
				t.name,
				t.position,
				t.played,
				t.won,
				t.drawn,
				t.lost,
				t.goalsFor,
				t.goalsAgainst,
				t.goalDiff,
				t.points,
			]),
		).toEqual([
			["Bravo", 1, 3, 1, 2, 0, 6, 3, 3, 5],
			["Delta", 2, 3, 1, 1, 1, 4, 3, 1, 4],
			["Charlie", 3, 3, 1, 1, 1, 2, 2, 0, 4],
			["Alfa", 4, 3, 1, 0, 2, 1, 5, -4, 3],
		]);
		expect(s.user).toEqual({
			position: 2,
			points: 4,
			won: 1,
			drawn: 1,
			lost: 1,
			goalsFor: 4,
			goalsAgainst: 3,
		});
		// 13 goals in 6 matches; home 3, draws 2, away 1.
		expect(s.stats.matches).toBe(6);
		expect(s.stats.goalsPerMatch).toBeCloseTo(13 / 6);
		expect(s.stats.homeWinPct).toBeCloseTo(50);
		expect(s.stats.drawPct).toBeCloseTo(100 / 3);
		expect(s.stats.awayWinPct).toBeCloseTo(100 / 6);
	});
});

describe("gameHistory", () => {
	const history = gameHistory({
		clubs,
		seasons: [
			{ seasonNo: 2, results: season2 },
			{ seasonNo: 1, results: season1 },
		],
		userClubId: 1,
	});

	it("lists completed seasons with champion and the user's line", () => {
		expect(history.seasons).toEqual([
			{
				seasonNo: 1,
				champion: "Bravo",
				position: 2,
				points: 4,
				won: 1,
				drawn: 1,
				lost: 1,
				goalsFor: 4,
				goalsAgainst: 3,
			},
			{
				seasonNo: 2,
				champion: "Delta",
				position: 1,
				points: 5,
				won: 1,
				drawn: 2,
				lost: 0,
				goalsFor: 8,
				goalsAgainst: 7,
			},
		]);
	});

	it("all-time table: sums, titles, tie on points broken by goal difference", () => {
		// Bravo and Delta both 9 points: Bravo +4 (10:6) ahead of Delta +2 (12:10)
		// although Delta scored more.
		expect(history.allTime).toEqual([
			{
				clubId: 4,
				name: "Bravo",
				seasons: 2,
				titles: 1,
				played: 6,
				won: 2,
				drawn: 3,
				lost: 1,
				goalsFor: 10,
				goalsAgainst: 6,
				points: 9,
			},
			{
				clubId: 1,
				name: "Delta",
				seasons: 2,
				titles: 1,
				played: 6,
				won: 2,
				drawn: 3,
				lost: 1,
				goalsFor: 12,
				goalsAgainst: 10,
				points: 9,
			},
			{
				clubId: 2,
				name: "Alfa",
				seasons: 2,
				titles: 0,
				played: 6,
				won: 2,
				drawn: 1,
				lost: 3,
				goalsFor: 6,
				goalsAgainst: 10,
				points: 7,
			},
			{
				clubId: 3,
				name: "Charlie",
				seasons: 2,
				titles: 0,
				played: 6,
				won: 1,
				drawn: 3,
				lost: 2,
				goalsFor: 3,
				goalsAgainst: 5,
				points: 6,
			},
		]);
	});

	it("empty when no season is completed", () => {
		expect(gameHistory({ clubs, seasons: [], userClubId: 1 })).toEqual({
			seasons: [],
			allTime: [],
		});
	});
});

describe("completedSeasons", () => {
	it("keeps only seasons before the current one, grouped and ordered", () => {
		const rows = [
			...season2.map((x) => ({ ...x, seasonNo: 2 })),
			...season1.map((x) => ({ ...x, seasonNo: 1 })),
			{ ...r(1, 2, 9, 0), seasonNo: 3 },
		];
		const seasons = completedSeasons(rows, 3);
		expect(seasons.map((s) => s.seasonNo)).toEqual([1, 2]);
		expect(seasons[0]?.results).toEqual(season1);
		expect(seasons[1]?.results).toEqual(season2);
		// The running season 3 never reaches the history.
		const h = gameHistory({ clubs, seasons, userClubId: 1 });
		expect(h.seasons.map((s) => s.seasonNo)).toEqual([1, 2]);
		expect(h.allTime.find((a) => a.clubId === 1)?.played).toBe(6);
		expect(completedSeasons(rows, 1)).toEqual([]);
	});
});
