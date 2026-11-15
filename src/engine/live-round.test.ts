import { describe, expect, it } from "vitest";
import type { PlayerAttributes, Position } from "./attributes";
import { LIVE_MODEL, playLive } from "./live-match";
import { prepareRound } from "./live-round";
import { freshState, type PlayerState, STATE_MODEL } from "./player-state";
import { createRng } from "./rng";
import { type SeasonFixture, simulateSeason } from "./season";
import { DEFAULT_TACTIC, FORMATIONS } from "./tactics";

let nextId = 1;
const player = (
	clubId: number,
	position: Position,
	overall: number,
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

/** 22 players: 2 GK, 7 DEF, 8 MID, 5 ATT; starters at `base`, the rest lower. */
const squadOf = (clubId: number, base: number) => {
	const spec: [Position, number, number][] = [
		["Goalkeeper", 1, 1],
		["Defender", 4, 3],
		["Midfielder", 4, 4],
		["Attacker", 2, 3],
	];
	return spec.flatMap(([pos, starters, bench]) => [
		...Array.from({ length: starters }, () => player(clubId, pos, base)),
		...Array.from({ length: bench }, (_, i) =>
			player(clubId, pos, base - 5 - i),
		),
	]);
};

/** 8 clubs, round 3 has 3 fixtures (clubs 7 and 8 do not play). */
const world = () => {
	const squads = new Map<number, PlayerAttributes[]>();
	for (let c = 1; c <= 8; c++) squads.set(c, squadOf(c, 50 + 3 * c));
	const fixtures: (SeasonFixture & { id: number })[] = [
		{ id: 31, round: 3, homeClubId: 1, awayClubId: 2 },
		{ id: 32, round: 3, homeClubId: 3, awayClubId: 4 },
		{ id: 33, round: 3, homeClubId: 5, awayClubId: 6 },
	];
	return { squads, fixtures };
};

const ids = (squad: PlayerAttributes[] | undefined) =>
	(squad ?? []).map((p) => p.playerId);

describe("prepareRound", () => {
	it("mecze tla jak w batchu: te same wyniki co simulateSeason na tym samym rng", () => {
		const { squads, fixtures } = world();
		const round = prepareRound(
			squads,
			new Map(),
			fixtures,
			3,
			null,
			createRng(77),
		);
		const background = fixtures.filter((f) => f.homeClubId !== 3);
		const batch = simulateSeason(background, squads, createRng(77));
		expect(
			round.background.map((b) => [b.fixture.id, b.homeGoals, b.awayGoals]),
		).toEqual(
			batch.map((r, i) => [background[i]?.id, r.homeGoals, r.awayGoals]),
		);
		for (const b of round.background) {
			expect(b.goals).toHaveLength(b.homeGoals + b.awayGoals);
			expect(b.goals.filter((g) => g.side === "home")).toHaveLength(
				b.homeGoals,
			);
			expect(b.goals.every((g) => g.minute >= 1 && g.minute <= 90)).toBe(true);
		}
		expect(round.fixture.id).toBe(32);
		expect(Number.isInteger(round.seed)).toBe(true);
	});

	it("stan po kolejce: cale kadry grajacych klubow, takze spoza skladu", () => {
		const { squads, fixtures } = world();
		const reserveBg = squads.get(1)?.at(-1);
		const reserveOwn = squads.get(3)?.at(-1);
		const reserveRival = squads.get(4)?.at(-1);
		const idle = squads.get(7)?.[0];
		if (!reserveBg || !reserveOwn || !reserveRival || !idle) throw new Error();
		const injured: PlayerState = {
			...freshState(),
			injuredFor: 3,
			fitness: 70,
		};
		const states = new Map<number, PlayerState>([
			[reserveBg.playerId, injured],
			[reserveOwn.playerId, injured],
			[reserveRival.playerId, injured],
			[idle.playerId, injured],
		]);
		const round = prepareRound(squads, states, fixtures, 3, null, createRng(5));
		for (const p of [reserveBg, reserveOwn, reserveRival]) {
			expect(round.states.get(p.playerId)).toMatchObject({
				injuredFor: 2,
				fitness: 70 + STATE_MODEL.fitnessRecovery,
			});
		}
		// A club that does not play keeps its state untouched.
		expect(round.states.get(idle.playerId)).toEqual(injured);
		const playing = [1, 2, 3, 4, 5, 6].flatMap((c) => ids(squads.get(c)));
		for (const id of playing) expect(round.states.has(id)).toBe(true);
		// Background lineups played: their state moved on (fitness cost of a match).
		const bgStarter = squads.get(5)?.[0];
		expect(round.states.get(bgStarter?.playerId ?? 0)?.fitness).toBe(
			100 - STATE_MODEL.fitnessCost,
		);
		// The input map is not mutated.
		expect(states.get(reserveOwn.playerId)).toEqual(injured);
	});

	it("setup meczu gracza: sklad gracza z dostepnych, rywal AI w 4-4-2 z lawka 9", () => {
		const { squads, fixtures } = world();
		const own = squads.get(4) ?? [];
		const eleven = own.slice(0, 11).map((p) => p.playerId);
		const bench = own.slice(11, 15).map((p) => p.playerId);
		const tired = own[0];
		if (!tired) throw new Error();
		const states = new Map([
			[tired.playerId, { ...freshState(), fitness: 50 }],
		]);
		const round = prepareRound(
			squads,
			states,
			fixtures,
			4,
			{ tactic: { formation: "4-4-2", style: "attacking" }, eleven, bench },
			createRng(9),
		);
		const { setup } = round;
		expect(setup.round).toBe(3);
		expect(setup.userSide).toBe("away");
		expect(setup.away.eleven.map((p) => p?.playerId)).toEqual(eleven);
		expect(setup.away.bench.map((p) => p.playerId)).toEqual(bench);
		expect(setup.away.tactic.style).toBe("attacking");
		// Overall is the effective (fitness-adjusted) value, state after beforeRound.
		expect(setup.away.eleven[0]?.overall).toBeLessThan(tired.overall);
		expect(setup.states[tired.playerId]?.fitness).toBe(
			50 + STATE_MODEL.fitnessRecovery,
		);
		expect(setup.home.clubId).toBe(3);
		expect(setup.home.tactic).toEqual(DEFAULT_TACTIC);
		expect(setup.home.eleven).toHaveLength(FORMATIONS["4-4-2"].length);
		expect(setup.home.bench).toHaveLength(LIVE_MODEL.benchSize);
		const r = playLive(setup, round.seed, [], 90);
		expect(r.finished).toBe(true);
	});

	it("rywal AI pomija niedostepnych, a niedostepny w skladzie gracza to blad", () => {
		const { squads, fixtures } = world();
		const rivalBest = squads.get(4)?.[0];
		const ownBest = squads.get(3)?.[0];
		if (!rivalBest || !ownBest) throw new Error();
		const states = new Map<number, PlayerState>([
			[rivalBest.playerId, { ...freshState(), suspendedFor: 1 }],
			[ownBest.playerId, { ...freshState(), injuredFor: 2 }],
		]);
		const round = prepareRound(squads, states, fixtures, 3, null, createRng(1));
		const rival = [...round.setup.away.eleven, ...round.setup.away.bench];
		expect(rival.some((p) => p?.playerId === rivalBest.playerId)).toBe(false);
		const own = ids(squads.get(3));
		expect(() =>
			prepareRound(
				squads,
				states,
				fixtures,
				3,
				{ tactic: DEFAULT_TACTIC, eleven: own.slice(0, 11), bench: [] },
				createRng(1),
			),
		).toThrow(/not available/);
		expect(() =>
			prepareRound(squads, states, fixtures, 7, null, createRng(1)),
		).toThrow(/no fixture/);
	});
});
