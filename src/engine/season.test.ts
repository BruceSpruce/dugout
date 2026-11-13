import { describe, expect, it } from "vitest";
import type { PlayerAttributes, Position } from "./attributes";
import { bestEleven } from "./club-strength";
import { createRng } from "./rng";
import {
	leagueStats,
	lineupEffect,
	pickBestEleven,
	reserveEleven,
	type SeasonFixture,
	simulateSeason,
	simulateSeasons,
	weakenedEleven,
} from "./season";

let nextId = 1;
const player = (
	position: Position,
	overall: number,
	clubId = 1,
): PlayerAttributes => ({
	playerId: nextId++,
	name: `P${nextId}`,
	clubId,
	position,
	minutes: 2000,
	attack: 50,
	creativity: 50,
	defense: 50,
	goalkeeping: 50,
	discipline: 50,
	overall,
});

/** Full 1-4-4-2 squad at `overall` plus a bench of 7 at `reserve` (1 GK, 2 DEF, 2 MID, 2 ATT). */
const squadOf = (
	clubId: number,
	overall: number,
	reserve = overall - 30,
): PlayerAttributes[] => {
	const spec: [Position, number, number][] = [
		["Goalkeeper", 1, 1],
		["Defender", 4, 2],
		["Midfielder", 4, 2],
		["Attacker", 2, 2],
	];
	return spec.flatMap(([pos, starters, bench]) => [
		...Array.from({ length: starters }, () => player(pos, overall, clubId)),
		...Array.from({ length: bench }, () => player(pos, reserve, clubId)),
	]);
};

const doubleRoundRobin = (ids: number[]): SeasonFixture[] => {
	const fixtures: SeasonFixture[] = [];
	let round = 1;
	for (const h of ids) {
		for (const a of ids) {
			if (h !== a)
				fixtures.push({ round: round++, homeClubId: h, awayClubId: a });
		}
	}
	return fixtures;
};

const fourClubs = () => {
	const clubs = [1, 2, 3, 4].map((id) => ({ clubId: id, name: `C${id}` }));
	const squads = new Map<number, PlayerAttributes[]>(
		[80, 65, 50, 35].map((o, i) => [i + 1, squadOf(i + 1, o)]),
	);
	return { fixtures: doubleRoundRobin([1, 2, 3, 4]), squads, clubs };
};

describe("leagueStats", () => {
	it("(a) matches a hand-computed mini season", () => {
		const clubs = [
			{ clubId: 1, name: "A" },
			{ clubId: 2, name: "B" },
			{ clubId: 3, name: "C" },
		];
		const results = [
			{ homeClubId: 1, awayClubId: 2, homeGoals: 2, awayGoals: 0 },
			{ homeClubId: 2, awayClubId: 3, homeGoals: 1, awayGoals: 1 },
			{ homeClubId: 3, awayClubId: 1, homeGoals: 0, awayGoals: 3 },
			{ homeClubId: 2, awayClubId: 3, homeGoals: 2, awayGoals: 1 },
		];
		// Points: A 6, B 4, C 1; mean 11/3, population variance 38/9.
		const s = leagueStats(results, clubs);
		expect(s.matches).toBe(4);
		expect(s.goalsPerMatch).toBe(2.5);
		expect(s.homeWinPct).toBe(50);
		expect(s.drawPct).toBe(25);
		expect(s.awayWinPct).toBe(25);
		expect(s.pointsStd).toBeCloseTo(Math.sqrt(38 / 9), 10);
		expect(s.championPoints).toBe(6);
		expect(s.lastPoints).toBe(1);
	});

	it("returns zeros for no matches", () => {
		expect(leagueStats([], [{ clubId: 1, name: "A" }])).toEqual({
			matches: 0,
			goalsPerMatch: 0,
			homeWinPct: 0,
			drawPct: 0,
			awayWinPct: 0,
			pointsStd: 0,
			championPoints: 0,
			lastPoints: 0,
		});
	});
});

describe("simulateSeason / simulateSeasons", () => {
	it("(b) is deterministic per seed and differs across seeds", () => {
		const input = fourClubs();
		const a = simulateSeasons(input, 5, 7);
		const b = simulateSeasons(input, 5, 7);
		const c = simulateSeasons(input, 5, 8);
		expect(b).toEqual(a);
		expect(c.perSeason).not.toEqual(a.perSeason);
	});

	it("(c) plays every fixture exactly once, rounds ascending", () => {
		const input = fourClubs();
		// Shuffle input order so sorting by round is exercised.
		const shuffled = [...input.fixtures].reverse();
		const results = simulateSeason(shuffled, input.squads, createRng(1));
		expect(results).toHaveLength(shuffled.length);
		const sorted = [...shuffled].sort((x, y) => x.round - y.round);
		expect(results.map((r) => [r.homeClubId, r.awayClubId])).toEqual(
			sorted.map((f) => [f.homeClubId, f.awayClubId]),
		);
		const pairs = new Set(
			results.map((r) => `${r.homeClubId}-${r.awayClubId}`),
		);
		expect(pairs.size).toBe(12);
	});

	it("keeps input order within a round and gives missing squads strength 0", () => {
		const fixtures: SeasonFixture[] = [
			{ round: 2, homeClubId: 1, awayClubId: 2 },
			{ round: 1, homeClubId: 2, awayClubId: 1 },
			{ round: 1, homeClubId: 1, awayClubId: 2 },
		];
		const squads = new Map([[1, squadOf(1, 70)]]);
		const results = simulateSeason(fixtures, squads, createRng(3));
		expect(results.map((r) => r.homeClubId)).toEqual([2, 1, 1]);
	});

	it("(d) a stronger club earns more points on average", () => {
		const input = fourClubs();
		const { points, stats, perSeason } = simulateSeasons(input, 200, 42);
		const mean = (id: number) => {
			const p = points.get(id) ?? [];
			return p.reduce((s, x) => s + x, 0) / p.length;
		};
		expect(perSeason).toHaveLength(200);
		expect(stats.matches).toBe(12);
		expect(mean(1)).toBeGreaterThan(mean(2));
		expect(mean(2)).toBeGreaterThan(mean(3));
		expect(mean(3)).toBeGreaterThan(mean(4));
	});

	it("simulates a 20-club season (380 matches) in under 1000 ms", () => {
		const ids = Array.from({ length: 20 }, (_, i) => i + 1);
		const clubs = ids.map((id) => ({ clubId: id, name: `C${id}` }));
		const squads = new Map(
			ids.map((id) => [id, squadOf(id, 60 + id)] as const),
		);
		const fixtures = doubleRoundRobin(ids).map((f, i) => ({
			...f,
			round: Math.floor(i / 10) + 1,
		}));
		expect(fixtures).toHaveLength(380);
		const start = performance.now();
		const results = simulateSeason(fixtures, squads, createRng(1));
		const elapsed = performance.now() - start;
		expect(results).toHaveLength(380);
		expect(leagueStats(results, clubs).matches).toBe(380);
		expect(elapsed).toBeLessThan(1000);
	});
});

describe("reserveEleven / weakenedEleven", () => {
	it("(e) reserveEleven shares no playerId with bestEleven, also with fillers", () => {
		const full = squadOf(1, 80);
		const ids = new Set(bestEleven(full).map((p) => p.playerId));
		expect(reserveEleven(full).some((p) => ids.has(p.playerId))).toBe(false);

		// No goalkeeper: best eleven contains an out-of-position filler copy.
		const noKeeper = squadOf(1, 80).filter((p) => p.position !== "Goalkeeper");
		const keeperIds = new Set(bestEleven(noKeeper).map((p) => p.playerId));
		const reserve = reserveEleven(noKeeper);
		expect(reserve.length).toBeGreaterThan(0);
		expect(reserve.some((p) => keeperIds.has(p.playerId))).toBe(false);
	});

	it("(e) weakenedEleven drops the 3 best of the best eleven", () => {
		const squad = [
			...squadOf(1, 70),
			player("Attacker", 95, 1),
			player("Midfielder", 90, 1),
			player("Defender", 85, 1),
		];
		const top3 = new Set(
			[...bestEleven(squad)]
				.sort((a, b) => b.overall - a.overall || a.playerId - b.playerId)
				.slice(0, 3)
				.map((p) => p.overall),
		);
		expect([...top3].sort()).toEqual([85, 90, 95]);
		const weakened = weakenedEleven(squad);
		expect(weakened.some((p) => p.overall >= 85)).toBe(false);
		const best = bestEleven(squad).map((p) => p.playerId);
		for (const p of weakened.filter((x) => best.includes(x.playerId))) {
			expect([95, 90, 85]).not.toContain(p.overall);
		}
		expect(weakened).toHaveLength(11);
	});

	it("pickBestEleven equals bestEleven", () => {
		const squad = squadOf(1, 70);
		expect(pickBestEleven(squad, 1)).toEqual(bestEleven(squad));
	});
});

describe("lineupEffect", () => {
	it("(f) weaker lineups cost points beyond 2 standard errors", () => {
		const input = fourClubs();
		// Make the top-3 of club 1 clearly better than its bench.
		const squad1 = squadOf(1, 80, 50);
		input.squads.set(1, squad1);
		for (const picker of [reserveEleven, weakenedEleven]) {
			const r = lineupEffect(input, 1, picker, 200, 11);
			expect(r.diff).toBeGreaterThan(2 * r.se);
			expect(r.bestPoints).toBeGreaterThan(r.variantPoints);
			expect(r.se).toBeGreaterThan(0);
		}
	});

	it("gives se 0 for n < 2", () => {
		const r = lineupEffect(fourClubs(), 1, reserveEleven, 1, 5);
		expect(r.se).toBe(0);
	});
});
