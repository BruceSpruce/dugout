import { describe, expect, it } from "vitest";

import { buildRoundScreen, type RoundScreenInput } from "./round-screen";

// 4 clubs, 6 rounds (double round robin), club 1 is the player.
const clubs = [
	{ clubId: 1, name: "Delta" },
	{ clubId: 2, name: "Alfa" },
	{ clubId: 3, name: "Charlie" },
	{ clubId: 4, name: "Bravo" },
];
const pairs: [number, number][] = [
	[1, 2],
	[3, 4],
	[1, 3],
	[4, 2],
	[1, 4],
	[2, 3],
];
const fixtures = pairs.flatMap(([h, a], i) => {
	const round = Math.floor(i / 2) + 1;
	return [
		{
			fixtureId: i + 1,
			round,
			kickoffAt: new Date(Date.UTC(2024, 7, round)),
			homeClubId: h,
			awayClubId: a,
		},
	];
});

const base: RoundScreenInput = {
	clubId: 1,
	currentRound: 1,
	totalRounds: 3,
	clubs,
	fixtures,
	results: [],
	liveMatch: null,
};

describe("buildRoundScreen", () => {
	it("(a) round 1: no previous round, zero table alphabetical, next match at home", () => {
		const s = buildRoundScreen(base);
		expect(s.previousRound).toBeNull();
		expect(s.table.map((r) => r.name)).toEqual([
			"Alfa",
			"Bravo",
			"Charlie",
			"Delta",
		]);
		expect(s.table.every((r) => r.points === 0 && r.played === 0)).toBe(true);
		expect(s.nextMatch).toMatchObject({
			fixtureId: 1,
			opponent: "Alfa",
			home: true,
			round: 1,
		});
		expect(s.clubName).toBe("Delta");
		const away = buildRoundScreen({ ...base, clubId: 2 });
		expect(away.nextMatch).toMatchObject({ opponent: "Delta", home: false });
	});

	it("(b) round 3 with results of rounds 1-2: points and previous round", () => {
		const s = buildRoundScreen({
			...base,
			currentRound: 3,
			results: [
				{ fixtureId: 1, homeGoals: 2, awayGoals: 0 },
				{ fixtureId: 2, homeGoals: 1, awayGoals: 1 },
				{ fixtureId: 3, homeGoals: 0, awayGoals: 1 },
				{ fixtureId: 4, homeGoals: 3, awayGoals: 0 },
			],
		});
		const pts = Object.fromEntries(s.table.map((r) => [r.name, r.points]));
		expect(pts).toEqual({ Delta: 3, Alfa: 0, Charlie: 4, Bravo: 4 });
		expect(s.table[0]?.name).toBe("Bravo");
		expect(s.previousRound).toEqual({
			round: 2,
			matches: [
				{ home: "Delta", away: "Charlie", homeGoals: 0, awayGoals: 1 },
				{ home: "Bravo", away: "Alfa", homeGoals: 3, awayGoals: 0 },
			],
		});
		expect(s.nextMatch).toMatchObject({ fixtureId: 5, opponent: "Bravo" });
	});

	it("(c) no club match in the current round: next match from later rounds", () => {
		const s = buildRoundScreen({
			...base,
			clubId: 1,
			currentRound: 2,
			fixtures: fixtures.filter((f) => f.fixtureId !== 3),
		});
		expect(s.nextMatch).toMatchObject({ fixtureId: 5, round: 3 });
	});

	it("(d) after the last round nextMatch is null", () => {
		const s = buildRoundScreen({ ...base, currentRound: 4 });
		expect(s.nextMatch).toBeNull();
		expect(s.previousRound?.round).toBe(3);
		expect(s.previousRound?.matches).toEqual([]);
	});

	it("(e) ignores game results whose fixture is not in this season's fixtures", () => {
		const s = buildRoundScreen({
			...base,
			currentRound: 2,
			results: [{ fixtureId: 999, homeGoals: 5, awayGoals: 0 }],
		});
		expect(s.table.every((r) => r.points === 0 && r.played === 0)).toBe(true);
		expect(s.previousRound?.matches).toEqual([]);
	});

	it("(f) last round with a match: next match in that round, kickoff date kept", () => {
		const s = buildRoundScreen({ ...base, currentRound: 3 });
		expect(s.nextMatch).toMatchObject({ fixtureId: 5, round: 3, home: true });
		expect(s.nextMatch?.kickoffAt).toEqual(new Date(Date.UTC(2024, 7, 3)));
		expect(s.clubId).toBe(1);
	});
});

describe("aiFinished", () => {
	// Round 1 written (fixture 1: Delta 2-1 Alfa), the game is in round 2.
	const afterRound1: RoundScreenInput = {
		...base,
		currentRound: 2,
		results: [
			{ fixtureId: 1, homeGoals: 2, awayGoals: 1 },
			{ fixtureId: 2, homeGoals: 0, awayGoals: 0 },
		],
		liveMatch: {
			status: "finished",
			round: 1,
			fixtureId: 1,
			changes: [
				{ minute: 20, by: "player", kind: "sub", out: 11, in: 12 },
				{ minute: 37, by: "ai", kind: "takeover" },
			],
		},
	};

	it("finished previous round with a takeover: clubs, score and takeover minute", () => {
		expect(buildRoundScreen(afterRound1).aiFinished).toEqual({
			home: "Delta",
			away: "Alfa",
			score: { home: 2, away: 1 },
			fromMinute: 37,
		});
	});

	it("null without a takeover, for a live match, for an older round and without a row", () => {
		const live = afterRound1.liveMatch;
		if (!live) throw new Error("fixture");
		const variants: RoundScreenInput[] = [
			{ ...afterRound1, liveMatch: { ...live, changes: [] } },
			{ ...afterRound1, liveMatch: { ...live, status: "live", round: 2 } },
			{ ...afterRound1, liveMatch: { ...live, status: "live" } },
			{ ...afterRound1, currentRound: 3 },
			{ ...afterRound1, liveMatch: null },
		];
		for (const v of variants) expect(buildRoundScreen(v).aiFinished).toBeNull();
	});
});
