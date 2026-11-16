import { describe, expect, it } from "vitest";

import type { PlayerAttributes, Position } from "~/engine/attributes";
import { playLive } from "~/engine/live-match";
import { freshState, type PlayerState } from "~/engine/player-state";
import { aiProposal, validateAvailability } from "./lineup";
import {
	ABANDON_AFTER_MINUTES,
	advanceMatch,
	aiTakeover,
	applyChange,
	exitMatch,
	type FlowFixture,
	finishRound,
	isAbandoned,
	type LiveMatchRow,
	matchView,
	nextPosition,
	type StartInput,
	startRound,
} from "./match-flow";

let nextId = 1;
const player = (
	clubId: number,
	position: Position,
	overall: number,
): PlayerAttributes => {
	const playerId = nextId++;
	return {
		playerId,
		name: `P${playerId}`,
		clubId,
		position,
		minutes: 2000,
		attack: 50,
		creativity: 50,
		defense: 50,
		goalkeeping: 50,
		discipline: 50,
		overall,
	};
};

/** 25 players: 3 GK, 8 DEF, 8 MID, 6 ATT. */
const squadOf = (clubId: number, base: number) => {
	const spec: [Position, number][] = [
		["Goalkeeper", 3],
		["Defender", 8],
		["Midfielder", 8],
		["Attacker", 6],
	];
	return spec.flatMap(([pos, n]) =>
		Array.from({ length: n }, (_, i) => player(clubId, pos, base - i)),
	);
};

const OWN = 1;
/** Rounds of a real season (the test world only has fixtures of rounds 1 and 2). */
const TOTAL_ROUNDS = 38;

/** 20 clubs, rounds 1 and 2 with 10 fixtures each; the user's club 1 plays club 2 at home in round 1. */
const world = () => {
	const squads = new Map<number, PlayerAttributes[]>();
	for (let c = 1; c <= 20; c++) squads.set(c, squadOf(c, 60 + c));
	const fixtures: FlowFixture[] = [];
	for (let i = 0; i < 10; i++) {
		fixtures.push({
			fixtureId: 100 + i,
			round: 1,
			homeClubId: 2 * i + 1,
			awayClubId: 2 * i + 2,
		});
		fixtures.push({
			fixtureId: 200 + i,
			round: 2,
			homeClubId: 2 * i + 2,
			awayClubId: 2 * i + 1,
		});
	}
	const clubs = [...squads.keys()].map((clubId) => ({
		clubId,
		name: `Klub ${clubId}`,
	}));
	return { squads, fixtures, clubs };
};

const baseInput = (
	w: ReturnType<typeof world>,
	over: Partial<StartInput> = {},
): StartInput => ({
	gameId: 7,
	clubId: OWN,
	seasonNo: 1,
	currentRound: 1,
	fixtures: w.fixtures,
	squads: w.squads,
	states: new Map(),
	lineup: null,
	existing: null,
	seed: 42,
	...over,
});

const started = (input: StartInput): LiveMatchRow => {
	const r = startRound(input);
	if (!r.ok) throw new Error(r.error);
	return r.row;
};

const atMinute = (row: LiveMatchRow, minute: number): LiveMatchRow => {
	const a = advanceMatch(row, minute);
	if (!a.ok) throw new Error(a.error);
	return { ...row, minute: a.minute, changes: a.changes };
};

const injured = (matches: number): PlayerState => ({
	...freshState(),
	injuredFor: matches,
});

const errorOf = (r: { ok: boolean; error?: string }) =>
	r.ok ? null : (r.error ?? null);

describe("startRound", () => {
	it("bez zapisanego skladu: AI z dostepnych zawodnikow (kontuzjowany pominiety)", () => {
		const w = world();
		const own = w.squads.get(OWN) ?? [];
		const best = aiProposal(own, "4-4-2").starters;
		const star = best[0] ?? -1;
		const row = started(
			baseInput(w, { states: new Map([[star, injured(2)]]) }),
		);
		const ids = row.setup.home.eleven.map((p) => p?.playerId);
		expect(row.setup.userSide).toBe("home");
		expect(row.setup.home.clubId).toBe(OWN);
		expect(ids).toHaveLength(11);
		expect(ids.every((id) => id !== undefined)).toBe(true);
		expect(ids).not.toContain(star);
		expect(row.setup.home.bench.map((p) => p.playerId)).not.toContain(star);
		expect(row.status).toBe("live");
		expect(row.minute).toBe(0);
		expect(row.changes).toEqual([]);
		expect(row.background.matches).toHaveLength(9);
	});

	it("zapisany sklad z kontuzjowanym zawodnikiem -> blad z nazwiskiem i liczba meczow", () => {
		const w = world();
		const lineup = aiProposal(w.squads.get(OWN) ?? [], "4-4-2");
		const star = lineup.starters[3] ?? -1;
		const r = startRound(
			baseInput(w, { lineup, states: new Map([[star, injured(2)]]) }),
		);
		expect(errorOf(r)).toBe(
			`Niedostępny zawodnik w składzie: P${star} — kontuzja, jeszcze 2 mecze`,
		);
	});

	it("zapisany sklad z pauzujacym na lawce -> blad", () => {
		const w = world();
		const lineup = aiProposal(w.squads.get(OWN) ?? [], "4-4-2");
		const sub = lineup.bench[0] ?? -1;
		const r = startRound(
			baseInput(w, {
				lineup,
				states: new Map([[sub, { ...freshState(), suspendedFor: 1 }]]),
			}),
		);
		expect(errorOf(r)).toMatch(/na ławce: .* pauza za kartki, jeszcze 1 mecz$/);
	});

	it("zapisany sklad trafia do meczu w kolejnosci slotow", () => {
		const w = world();
		const lineup = {
			...aiProposal(w.squads.get(OWN) ?? [], "4-3-3"),
			style: "attacking" as const,
		};
		const row = started(baseInput(w, { lineup }));
		expect(row.setup.home.tactic).toEqual({
			formation: "4-3-3",
			style: "attacking",
		});
		expect(row.setup.home.eleven.map((p) => p?.playerId)).toEqual(
			lineup.starters,
		);
		expect(row.setup.home.bench.map((p) => p.playerId)).toEqual(lineup.bench);
	});

	it("mecz juz trwa / brak meczu w kolejce -> blad; wiersz finished mozna nadpisac", () => {
		const w = world();
		expect(errorOf(startRound(baseInput(w, { existing: "live" })))).toBe(
			"Mecz już trwa.",
		);
		expect(errorOf(startRound(baseInput(w, { currentRound: 3 })))).toMatch(
			/nie ma meczu/,
		);
		expect(startRound(baseInput(w, { existing: "finished" })).ok).toBe(true);
	});

	it("jest deterministyczny dla seeda i przezywa zapis do jsonb", () => {
		const w = world();
		const a = started(baseInput(w));
		const b = started(baseInput(w));
		expect(a).toEqual(b);
		const stored = JSON.parse(JSON.stringify(a)) as LiveMatchRow;
		expect(matchView(atMinute(stored, 90), w.clubs, [])).toEqual(
			matchView(atMinute(a, 90), w.clubs, []),
		);
	});
});

describe("advanceMatch / applyChange", () => {
	it("zegar tylko do przodu, maks. 90", () => {
		const w = world();
		const row = atMinute(started(baseInput(w)), 30);
		expect(row.minute).toBe(30);
		const back = advanceMatch(row, 10);
		expect(back.ok && back.minute).toBe(30);
		const over = advanceMatch(row, 500);
		expect(over.ok && over.minute).toBe(90);
		expect(errorOf(advanceMatch({ ...row, status: "finished" }, 40))).toBe(
			"Mecz nie trwa.",
		);
	});

	it("zmiana gracza w biezacej minucie serwera, walidowana przez silnik", () => {
		const w = world();
		const row = atMinute(started(baseInput(w)), 60);
		const out = row.setup.home.eleven[10]?.playerId ?? -1;
		const inId = row.setup.home.bench[0]?.playerId ?? -1;
		const live = playLive(row.setup, row.seed, row.changes, 60);
		const onPitch = live.onPitch.home.some((s) => s.playerId === out);
		const r = applyChange(row, { kind: "sub", out, in: inId });
		if (onPitch) {
			expect(r.ok).toBe(true);
			expect(r.ok && r.changes.at(-1)).toEqual({
				minute: 60,
				by: "player",
				kind: "sub",
				out,
				in: inId,
			});
		}
		const bad = applyChange(row, { kind: "sub", out: inId, in: out });
		expect(bad.ok).toBe(false);
		const tactic = applyChange(row, {
			kind: "tactic",
			formation: "4-3-3",
			style: "defensive",
		});
		expect(tactic.ok && tactic.changes.at(-1)?.minute).toBe(60);
		expect(
			applyChange(atMinute(row, 90), {
				kind: "tactic",
				formation: "4-3-3",
				style: "defensive",
			}).ok,
		).toBe(false);
	});

	it("kontuzja zawodnika gracza: advance dopisuje jawna zmiane AI w minucie kontuzji", () => {
		const w = world();
		let found = false;
		for (let seed = 1; seed <= 300 && !found; seed++) {
			const row = started(baseInput(w, { seed }));
			const timeline = playLive(row.setup, row.seed, [], 90);
			const injury = timeline.events.find(
				(e) => e.kind === "injury" && e.side === "home" && e.minute < 85,
			);
			if (!injury) continue;
			found = true;
			const paused = atMinute(row, injury.minute);
			expect(paused.changes).toEqual([]);
			const resumed = atMinute(paused, injury.minute + 1);
			expect(resumed.changes).toContainEqual(
				expect.objectContaining({
					minute: injury.minute,
					by: "ai",
					kind: "sub",
					out: injury.playerId,
				}),
			);
		}
		expect(found).toBe(true);
	});
});

describe("exitMatch / isAbandoned / aiTakeover", () => {
	it("wyjscie w 37': minuta 90 i jedno przejecie AI w 37'", () => {
		const w = world();
		const row = atMinute(started(baseInput(w)), 37);
		const r = exitMatch(row);
		if (!r.ok) throw new Error(r.error);
		expect(r.minute).toBe(90);
		const takeovers = r.changes.filter((c) => c.kind === "takeover");
		expect(takeovers).toEqual([{ minute: 37, by: "ai", kind: "takeover" }]);
		expect(aiTakeover(r.changes)).toBe(37);
		const finish = finishRound(
			{
				...row,
				minute: r.minute,
				changes: r.changes,
			},
			TOTAL_ROUNDS,
		);
		expect(finish.ok).toBe(true);
	});

	it("wyjscie w 90': bez przejecia; poza live -> blad", () => {
		const w = world();
		const row = atMinute(started(baseInput(w)), 90);
		const r = exitMatch(row);
		if (!r.ok) throw new Error(r.error);
		expect(r.minute).toBe(90);
		expect(r.changes).toEqual(row.changes);
		expect(aiTakeover(r.changes)).toBeNull();
		expect(errorOf(exitMatch({ ...row, status: "finished" }))).toBe(
			"Mecz nie trwa.",
		);
	});

	it("isAbandoned na granicy 30 minut", () => {
		expect(ABANDON_AFTER_MINUTES).toBe(30);
		const updatedAt = new Date(Date.UTC(2026, 10, 15, 12, 0, 0));
		const at = (m: number, s: number) =>
			new Date(updatedAt.getTime() + (m * 60 + s) * 1000);
		expect(isAbandoned(updatedAt, at(29, 59))).toBe(false);
		expect(isAbandoned(updatedAt, at(30, 0))).toBe(true);
		expect(isAbandoned(updatedAt, at(45, 0))).toBe(true);
	});

	it("aiTakeover: minuta przejecia albo null", () => {
		expect(aiTakeover([])).toBeNull();
		expect(
			aiTakeover([
				{ minute: 10, by: "player", kind: "sub", out: 1, in: 2 },
				{ minute: 55, by: "ai", kind: "takeover" },
			]),
		).toBe(55);
	});
});

describe("matchView", () => {
	it("tabela na zywo w 45' liczy biezace wyniki kolejki i wczesniejsze wyniki gry", () => {
		const w = world();
		const row = atMinute(started(baseInput(w)), 45);
		const earlier = [
			{
				fixtureId: 1,
				homeClubId: 3,
				awayClubId: 4,
				homeGoals: 5,
				awayGoals: 0,
			},
		];
		const view = matchView(row, w.clubs, earlier);
		expect(view.minute).toBe(45);
		expect(view.others).toHaveLength(9);
		for (const o of view.others) {
			const m = row.background.matches.find((b) => b.fixtureId === o.fixtureId);
			const upTo = (m?.goals ?? []).filter((g) => g.minute <= 45);
			expect(o.homeGoals + o.awayGoals).toBe(upTo.length);
			expect(o.homeGoals).toBeLessThanOrEqual(m?.homeGoals ?? 0);
		}
		const played = view.table.map((t) => [t.clubId, t.played]);
		for (const [clubId, n] of played) {
			expect(n).toBe(clubId === 3 || clubId === 4 ? 2 : 1);
		}
		const live = playLive(row.setup, row.seed, row.changes, 45);
		expect(view.score).toEqual(live.score);
		const goalsInTable = view.table.reduce((s, t) => s + t.goalsFor, 0);
		const current =
			live.score.home +
			live.score.away +
			view.others.reduce((s, o) => s + o.homeGoals + o.awayGoals, 0);
		expect(goalsInTable).toBe(current + 5);
		expect(view.home.slots).toHaveLength(11);
		expect(view.home.name).toBe("Klub 1");
		expect(
			view.events.every(
				(e, i, a) => i === 0 || (a[i - 1]?.minute ?? 0) >= e.minute,
			),
		).toBe(true);
	});
});

describe("finishRound", () => {
	it("przed 90' -> blad", () => {
		const w = world();
		const row = atMinute(started(baseInput(w)), 89);
		expect(errorOf(finishRound(row, TOTAL_ROUNDS))).toBe("Mecz jeszcze trwa.");
	});

	it("zapisuje 10 wynikow kolejki i stan wszystkich zawodnikow kadr klubow, ktore graly", () => {
		const w = world();
		const own = w.squads.get(OWN) ?? [];
		const reserve = own.at(-1)?.playerId ?? -1;
		const row = atMinute(
			started(baseInput(w, { states: new Map([[reserve, injured(3)]]) })),
			90,
		);
		const r = finishRound(row, TOTAL_ROUNDS);
		if (!r.ok) throw new Error(r.error);
		expect(r.from).toEqual({ seasonNo: 1, round: 1 });
		expect(r.next).toEqual({ seasonNo: 1, round: 2, seasonEnded: false });
		expect(r.results).toHaveLength(10);
		expect(new Set(r.results.map((x) => x.fixtureId)).size).toBe(10);
		const live = playLive(row.setup, row.seed, row.changes, 90);
		expect(r.results[0]).toEqual({
			fixtureId: 100,
			homeGoals: live.score.home,
			awayGoals: live.score.away,
		});

		const states = new Map(r.states.map((s) => [s.playerId, s.state]));
		const allPlayers = [...w.squads.values()].flat();
		expect(r.states).toHaveLength(allPlayers.length);
		for (const p of allPlayers) expect(states.has(p.playerId)).toBe(true);

		// Injured reserve outside the lineup: the injury counts down after the round.
		expect(states.get(reserve)?.injuredFor).toBe(2);

		// Players of the user's match lose fitness by minutes played; the rival too.
		for (const p of live.outcome?.players ?? []) {
			expect(states.get(p.playerId)).toEqual(p.state);
		}
		const rivalStarter = row.setup.away.eleven[0]?.playerId ?? -1;
		expect(states.get(rivalStarter)?.fitness).toBeLessThan(100);
		// Background club starters played a batch match (fitness - 12, recovered + 9 first).
		const bgStarter = row.background.states.find((s) => s.state.fitness < 100);
		expect(bgStarter).toBeDefined();
	});

	it("bez zmian kolejka 2 startuje ze stanem po kolejce 1", () => {
		const w = world();
		const r = finishRound(atMinute(started(baseInput(w)), 90), TOTAL_ROUNDS);
		if (!r.ok) throw new Error(r.error);
		const states = new Map(r.states.map((s) => [s.playerId, s.state]));
		const next = startRound(
			baseInput(w, {
				seasonNo: r.next.seasonNo,
				currentRound: r.next.round,
				states,
				existing: "finished",
			}),
		);
		expect(next.ok).toBe(true);
		expect(next.ok && next.row.setup.away.clubId).toBe(OWN);
		expect(next.ok && next.row.setup.userSide).toBe("away");
	});

	it("w ostatniej kolejce sezonu: nastepna pozycja to 1. kolejka kolejnego sezonu", () => {
		const w = world();
		const row = atMinute(
			started(baseInput(w, { seasonNo: 3, currentRound: 2 })),
			90,
		);
		expect(row.seasonNo).toBe(3);
		const r = finishRound(row, 2);
		if (!r.ok) throw new Error(r.error);
		expect(r.from).toEqual({ seasonNo: 3, round: 2 });
		expect(r.next).toEqual({ seasonNo: 4, round: 1, seasonEnded: true });
		expect(r.results).toHaveLength(10);
	});
});

describe("nextPosition", () => {
	it("37 -> 38 tego samego sezonu", () => {
		expect(nextPosition({ seasonNo: 1, round: 37 }, 38)).toEqual({
			seasonNo: 1,
			round: 38,
			seasonEnded: false,
		});
	});

	it("38 -> 1. kolejka kolejnego sezonu", () => {
		expect(nextPosition({ seasonNo: 1, round: 38 }, 38)).toEqual({
			seasonNo: 2,
			round: 1,
			seasonEnded: true,
		});
	});

	it("1. kolejka sezonu 2 -> 2. kolejka sezonu 2", () => {
		expect(nextPosition({ seasonNo: 2, round: 1 }, 38)).toEqual({
			seasonNo: 2,
			round: 2,
			seasonEnded: false,
		});
	});
});

describe("validateAvailability", () => {
	it("odrzuca kontuzjowanego w skladzie", () => {
		const w = world();
		const squad = w.squads.get(OWN) ?? [];
		const lineup = aiProposal(squad, "4-4-2");
		const id = lineup.starters[5] ?? -1;
		expect(validateAvailability(lineup, squad, new Map())).toEqual({
			ok: true,
		});
		const r = validateAvailability(lineup, squad, new Map([[id, injured(5)]]));
		expect(errorOf(r)).toBe(
			`Niedostępny zawodnik w składzie: P${id} — kontuzja, jeszcze 5 meczów`,
		);
	});
});
