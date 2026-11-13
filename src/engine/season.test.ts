import { describe, expect, it } from "vitest";
import type { PlayerAttributes, Position } from "./attributes";
import { bestEleven, lineupStrength } from "./club-strength";
import { MATCH_MODEL, simulateMatch } from "./match";
import { STATE_MODEL } from "./player-state";
import { createRng } from "./rng";
import {
	type LineupPicker,
	leagueStats,
	lineupEffect,
	matchStrength,
	pickBestEleven,
	reserveEleven,
	type SeasonFixture,
	simulateSeason,
	simulateSeasonDetailed,
	simulateSeasons,
	weakenedEleven,
} from "./season";
import { DEFAULT_TACTIC, type Tactic } from "./tactics";

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

/** Double round-robin by the circle method (even club count): every club plays exactly once per round. */
const doubleRoundRobin = (ids: number[]): SeasonFixture[] => {
	const n = ids.length;
	const first: SeasonFixture[] = [];
	const rest = ids.slice(1);
	for (let r = 0; r < n - 1; r++) {
		const arr = [ids[0] as number, ...rest];
		for (let i = 0; i < n / 2; i++) {
			const x = arr[i] as number;
			const y = arr[n - 1 - i] as number;
			const flip = (r + i) % 2 === 1;
			first.push({
				round: r + 1,
				homeClubId: flip ? y : x,
				awayClubId: flip ? x : y,
			});
		}
		rest.unshift(rest.pop() as number);
	}
	const second = first.map((f) => ({
		round: f.round + n - 1,
		homeClubId: f.awayClubId,
		awayClubId: f.homeClubId,
	}));
	return [...first, ...second];
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
			yellowsPerMatch: 0,
			redsPerMatch: 0,
			injuredPerClub: 0,
			suspensionsPerClub: 0,
			avgLineupFitness: 0,
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
			{ round: 1, homeClubId: 4, awayClubId: 3 },
			{ round: 1, homeClubId: 2, awayClubId: 1 },
		];
		const squads = new Map([[1, squadOf(1, 70)]]);
		const results = simulateSeason(fixtures, squads, createRng(3));
		expect(results.map((r) => r.homeClubId)).toEqual([4, 2, 1]);
	});

	it("a club missing from squads has strength 0 and loses to a full squad", () => {
		const fixtures: SeasonFixture[] = Array.from({ length: 200 }, (_, i) => ({
			round: i + 1,
			homeClubId: 1,
			awayClubId: 2,
		}));
		const squads = new Map([[1, squadOf(1, 90)]]);
		const results = simulateSeason(fixtures, squads, createRng(5));
		const sum = (f: (r: (typeof results)[number]) => number) =>
			results.reduce((a, r) => a + f(r), 0);
		// Club 2 has no squad: lineupStrength([]) is 0, so club 1 outscores it clearly.
		expect(lineupStrength([])).toBe(0);
		expect(sum((r) => r.homeGoals)).toBeGreaterThan(sum((r) => r.awayGoals));
	});

	it("calls a club's picker once per round it plays, with that round number", () => {
		const input = fourClubs();
		const calls: number[] = [];
		const picker: LineupPicker = (squad, round) => {
			calls.push(round);
			return bestEleven(squad);
		};
		// Club 1 plays in every round 1..6 of a 4-club double round-robin.
		const fixtures = input.fixtures;
		const rounds = new Set(
			fixtures
				.filter((f) => f.homeClubId === 1 || f.awayClubId === 1)
				.map((f) => f.round),
		);
		simulateSeason(fixtures, input.squads, createRng(2), {
			pickers: new Map([[1, picker]]),
		});
		expect([...calls].sort((a, b) => a - b)).toEqual(
			[...rounds].sort((a, b) => a - b),
		);
		expect(calls).toHaveLength(rounds.size);
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
		const fixtures = doubleRoundRobin(ids);
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

describe("tactics in the season", () => {
	it("(h) an attacking style scores and concedes more than a defensive one (200 seasons)", () => {
		const input = fourClubs();
		const run = (style: Tactic["style"]) => {
			const r = simulateSeasons(input, 200, 21, {
				tactics: new Map([[1, { ...DEFAULT_TACTIC, style }]]),
			});
			const mean = (m: Map<number, number[]>) => {
				const xs = m.get(1) ?? [];
				return xs.reduce((s, x) => s + x, 0) / xs.length;
			};
			return { gf: mean(r.goalsFor), ga: mean(r.goalsAgainst) };
		};
		const attacking = run("attacking");
		const defensive = run("defensive");
		expect(attacking.gf).toBeGreaterThan(defensive.gf);
		expect(attacking.ga).toBeGreaterThan(defensive.ga);
	});

	it("(i) the picker receives the club's tactic, default for clubs without one", () => {
		const input = fourClubs();
		const seen = new Map<number, Tactic[]>();
		const spyFor =
			(clubId: number): LineupPicker =>
			(squad, _round, tactic) => {
				seen.set(clubId, [...(seen.get(clubId) ?? []), tactic]);
				return pickBestEleven(squad, 0, tactic);
			};
		const wanted: Tactic = { formation: "4-3-3", style: "attacking" };
		simulateSeason(input.fixtures, input.squads, createRng(3), {
			pickers: new Map([
				[1, spyFor(1)],
				[2, spyFor(2)],
			]),
			tactics: new Map([[1, wanted]]),
		});
		expect(seen.get(1)?.length).toBeGreaterThan(0);
		expect(seen.get(1)?.every((t) => t === wanted)).toBe(true);
		expect(seen.get(2)?.every((t) => t === DEFAULT_TACTIC)).toBe(true);
	});
});

describe("player state in the season", () => {
	// 4 clubs, exactly 1 match per club per round (6 rounds of 2 matches).
	const roundsOf2 = () => fourClubs();
	const noInjury = { ...STATE_MODEL, injuryRate: 0 };

	it("(h) an unavailable player is not in the picked lineup", () => {
		const input = roundsOf2();
		const squad1 = input.squads.get(1) ?? [];
		const seen: { round: number; ids: number[] }[] = [];
		const picker: LineupPicker = (squad, round) => {
			seen.push({ round, ids: squad.map((p) => p.playerId) });
			return bestEleven(squad);
		};
		const lineups: { round: number; ids: number[] }[] = [];
		const spy: LineupPicker = (squad, round, tactic) => {
			const l = picker(squad, round, tactic);
			lineups.push({ round, ids: l.map((p) => p.playerId) });
			return l;
		};
		// Everybody is banned after the first match (yellow certain, 3-match straight red certain-ish).
		const stateModel = {
			...STATE_MODEL,
			yellowBase: 1,
			redBase: 1,
			secondYellowShare: 0,
			disciplineSlope: 0,
			injuryRate: 0,
		};
		simulateSeason(input.fixtures, input.squads, createRng(4), {
			pickers: new Map([[1, spy]]),
			stateModel,
		});
		// Round 1: full squad offered; later rounds: the 11 red-carded players are out for 3 matches.
		const first = seen[0];
		expect(first?.ids).toHaveLength(squad1.length);
		const banned = new Set(lineups[0]?.ids);
		expect(banned.size).toBe(11);
		for (const r of seen.slice(1, 4)) {
			expect(r.ids.some((id) => banned.has(id))).toBe(false);
		}
		expect(seen[1]?.ids).toHaveLength(squad1.length - 11);
		// Exact return: the ban of 3 covers rounds 2-4, in round 5 they are offered and picked again.
		for (const id of banned) {
			expect(seen[4]?.ids).toContain(id);
			expect(lineups[4]?.ids).toContain(id);
		}
	});

	it("(h) an injured player is not offered while injured", () => {
		const input = roundsOf2();
		const offered: number[][] = [];
		const picked: number[][] = [];
		const spy: LineupPicker = (squad) => {
			offered.push(squad.map((p) => p.playerId));
			const l = bestEleven(squad);
			picked.push(l.map((p) => p.playerId));
			return l;
		};
		const stateModel = {
			...STATE_MODEL,
			yellowBase: 0,
			redBase: 0,
			injuryRate: 1,
			injuryDurations: [{ matches: [2, 2] as [number, number], weight: 1 }],
		};
		simulateSeason(input.fixtures, input.squads, createRng(1), {
			pickers: new Map([[1, spy]]),
			stateModel,
		});
		const injuredAfterR1 = new Set(
			bestEleven(input.squads.get(1) ?? []).map((p) => p.playerId),
		);
		// Offered in round 1; out in rounds 2 and 3 (injured for 2 matches); the rest of the squad plays.
		expect(offered[0]?.some((id) => injuredAfterR1.has(id))).toBe(true);
		expect(offered[1]?.some((id) => injuredAfterR1.has(id))).toBe(false);
		expect(offered[2]?.some((id) => injuredAfterR1.has(id))).toBe(false);
		// Exact return: in round 4 they are offered and picked again.
		for (const id of injuredAfterR1) {
			expect(offered[3]).toContain(id);
			expect(picked[3]).toContain(id);
		}
	});

	it("throws when a club plays twice in one round (consequences on and off)", () => {
		const fixtures: SeasonFixture[] = [
			{ round: 3, homeClubId: 1, awayClubId: 2 },
			{ round: 3, homeClubId: 3, awayClubId: 1 },
		];
		const squads = new Map([[1, squadOf(1, 70)]]);
		for (const consequences of [true, false]) {
			expect(() =>
				simulateSeason(fixtures, squads, createRng(1), { consequences }),
			).toThrow("simulateSeason: club 1 plays twice in round 3");
		}
	});

	it("matchStrength counts missing slots as 0", () => {
		const eleven = bestEleven(squadOf(1, 70));
		expect(eleven).toHaveLength(11);
		expect(matchStrength(eleven)).toBeCloseTo(lineupStrength(eleven), 10);
		const eight = eleven.slice(0, 8);
		expect(matchStrength(eight)).toBeCloseTo(
			(lineupStrength(eight) * 8) / 11,
			10,
		);
		expect(matchStrength([])).toBe(0);
	});

	it("(i) consequences:false ignores player state and uses no extra draws", () => {
		const input = fourClubs();
		const rough = new Map(
			[...input.squads].map(([id, sq]) => [
				id,
				sq.map((p) => ({ ...p, discipline: 0 })),
			]),
		);
		const run = (squads: typeof input.squads, consequences: boolean) =>
			simulateSeason(input.fixtures, squads, createRng(9), { consequences });
		expect(run(rough, false)).toEqual(run(input.squads, false));
		// Reds and injuries matter when consequences are on.
		expect(run(rough, true)).not.toEqual(run(input.squads, true));
		// Same draw path as plain S-10: simulateMatch only, one stream.
		const rng = createRng(9);
		const manual = input.fixtures.map((f) =>
			simulateMatch(
				lineupStrength(bestEleven(input.squads.get(f.homeClubId) ?? [])),
				lineupStrength(bestEleven(input.squads.get(f.awayClubId) ?? [])),
				rng,
				MATCH_MODEL,
			),
		);
		expect(
			run(input.squads, false).map((r) => [r.homeGoals, r.awayGoals]),
		).toEqual(manual.map((m) => [m.homeGoals, m.awayGoals]));
	});

	it("(j) a regular starter is tired, a reserve is fresh", () => {
		const input = roundsOf2();
		const fitnessSeen = new Map<number, number>();
		const stateModel = {
			...noInjury,
			yellowBase: 0,
			redBase: 0,
			formWeight: 0,
		};
		const squad = input.squads.get(1) ?? [];
		const starters = new Set(bestEleven(squad).map((p) => p.playerId));
		const spy: LineupPicker = (sq) => {
			for (const p of sq)
				fitnessSeen.set(
					p.playerId,
					Math.min(fitnessSeen.get(p.playerId) ?? Infinity, p.overall),
				);
			return bestEleven(sq);
		};
		simulateSeason(input.fixtures, input.squads, createRng(4), {
			pickers: new Map([[1, spy]]),
			stateModel,
		});
		// Overall copies are fitness-adjusted: starters (80) are below 80 at some point, bench (50) is not.
		const starter = squad.find((p) => starters.has(p.playerId));
		const bench = squad.find((p) => !starters.has(p.playerId));
		expect(fitnessSeen.get(starter?.playerId ?? -1)).toBeLessThan(
			starter?.overall ?? 0,
		);
		expect(fitnessSeen.get(bench?.playerId ?? -1)).toBeCloseTo(
			bench?.overall ?? 0,
			10,
		);
	});

	it("(k) state stats on a deterministic mini season", () => {
		const clubs = [1, 2];
		const squads = new Map(clubs.map((id) => [id, squadOf(id, 70)] as const));
		const fixtures: SeasonFixture[] = [
			{ round: 1, homeClubId: 1, awayClubId: 2 },
			{ round: 2, homeClubId: 2, awayClubId: 1 },
		];
		// Nearly everyone gets a yellow in every match (no red, no injury, no ban before count 5).
		const stateModel = {
			...STATE_MODEL,
			yellowBase: 1,
			redBase: 0,
			secondYellowShare: 0,
			disciplineSlope: 0,
			injuryRate: 0,
		};
		const { results, state } = simulateSeasonDetailed(
			fixtures,
			squads,
			createRng(3),
			{ stateModel },
		);
		// Card probability is capped at 0.95, so ~42 of 44 player-matches.
		expect(state.yellows).toBeGreaterThan(36);
		expect(state.yellows).toBeLessThanOrEqual(44);
		expect(state.reds).toBe(0);
		expect(state.injuries).toBe(0);
		expect(state.injuredPerClubRound).toBe(0);
		expect(state.suspensionsPerClub).toBe(0);
		// Round 1: fitness 100 (recovery capped), round 2: 100 - 12 + 9 = 97 -> mean 98.5.
		expect(state.avgLineupFitness).toBeCloseTo(98.5, 10);
		const stats = leagueStats(
			results,
			[
				{ clubId: 1, name: "A" },
				{ clubId: 2, name: "B" },
			],
			state,
		);
		expect(stats.yellowsPerMatch).toBe(state.yellows / 2);
		expect(stats.redsPerMatch).toBe(0);
		expect(stats.avgLineupFitness).toBeCloseTo(98.5, 10);

		// Certain straight reds: 22 reds in round 1 -> 3-match bans started per club: 11.
		const redModel = { ...stateModel, yellowBase: 0, redBase: 1 };
		const red = simulateSeasonDetailed(fixtures, squads, createRng(3), {
			stateModel: redModel,
		}).state;
		expect(red.reds).toBeGreaterThanOrEqual(22);
		expect(red.suspensionsPerClub).toBeGreaterThanOrEqual(11);
		// Certain injuries of 5 matches: round 2 sees 11 injured per club.
		const injModel = {
			...stateModel,
			yellowBase: 0,
			injuryRate: 1,
			injuryDurations: [{ matches: [5, 5] as [number, number], weight: 1 }],
		};
		const inj = simulateSeasonDetailed(fixtures, squads, createRng(3), {
			stateModel: injModel,
		}).state;
		// Round 2: the 11 injured starters are out, only the 7 reserves play (22 + 14).
		expect(inj.injuries).toBe(36);
		expect(inj.injuredPerClubRound).toBeCloseTo(5.5, 10);
	});

	it("(l) is deterministic per seed with consequences on", () => {
		const input = roundsOf2();
		const a = simulateSeasonDetailed(
			input.fixtures,
			input.squads,
			createRng(5),
		);
		const b = simulateSeasonDetailed(
			input.fixtures,
			input.squads,
			createRng(5),
		);
		expect(b).toEqual(a);
		expect(a.state.yellows).toBeGreaterThan(0);
	});

	it("simulates a 20-club season with consequences in under 1000 ms", () => {
		const ids = Array.from({ length: 20 }, (_, i) => i + 1);
		const squads = new Map(
			ids.map((id) => [id, squadOf(id, 60 + id)] as const),
		);
		const fixtures = doubleRoundRobin(ids);
		const start = performance.now();
		const { results } = simulateSeasonDetailed(fixtures, squads, createRng(1), {
			consequences: true,
		});
		const elapsed = performance.now() - start;
		expect(results).toHaveLength(380);
		expect(elapsed).toBeLessThan(1000);
	});
});
