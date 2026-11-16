import { describe, expect, it } from "vitest";
import type { PlayerAttributes, Position } from "./attributes";
import {
	DRAW_PCT_RANGE,
	GOALS_RANGE,
	HOME_WIN_PCT_RANGE,
} from "./calibration-report";
import { liveStats } from "./live-calibration";
import {
	aiLiveTeam,
	deriveSeed,
	injuryAutoSubs,
	LIVE_MODEL,
	type LiveChange,
	type LiveModel,
	type LiveSetup,
	type LiveTeam,
	playLive,
	validateChange,
} from "./live-match";
import { expectedGoalsRatings, scoreProbabilities } from "./match";
import { STATE_MODEL } from "./player-state";
import type { SeasonFixture } from "./season";
import { DEFAULT_TACTIC, FORMATIONS, teamRatings } from "./tactics";

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
	attack: position === "Attacker" ? 70 : position === "Midfielder" ? 50 : 20,
	creativity: 50,
	defense: 50,
	goalkeeping: position === "Goalkeeper" ? 70 : 0,
	discipline: 50,
	overall,
});

/**
 * PL-like squad: 11 starters around `base` (attackers +4, keeper and defenders -2, so attack
 * exceeds defense as in real ratings), a bench of 9 at -benchGap.
 */
const squadOf = (clubId: number, base: number, benchGap = 7) => {
	const spec: [Position, number, number, number][] = [
		["Goalkeeper", 1, 1, -2],
		["Defender", 4, 3, -2],
		["Midfielder", 4, 3, 0],
		["Attacker", 2, 2, 4],
	];
	return spec.flatMap(([pos, starters, bench, offset]) => [
		...Array.from({ length: starters }, () =>
			player(clubId, pos, base + offset),
		),
		...Array.from({ length: bench }, () =>
			player(clubId, pos, base + offset - benchGap),
		),
	]);
};

/** 20 clubs with starter levels 57..76 and every home/away pairing once (380 fixtures). */
const league = (benchGap = 7) => {
	const squads = new Map<number, PlayerAttributes[]>();
	for (let c = 1; c <= 20; c++) squads.set(c, squadOf(c, 56 + c, benchGap));
	const fixtures: SeasonFixture[] = [];
	for (let h = 1; h <= 20; h++) {
		for (let a = 1; a <= 20; a++) {
			if (h !== a) fixtures.push({ round: 1, homeClubId: h, awayClubId: a });
		}
	}
	return { squads, fixtures };
};

const LEAGUE = league();
const teamOf = (
	squads: Map<number, PlayerAttributes[]>,
	clubId: number,
): LiveTeam => aiLiveTeam(clubId, squads.get(clubId) ?? [], DEFAULT_TACTIC);

const setupOf = (
	home: LiveTeam,
	away: LiveTeam,
	userSide: LiveSetup["userSide"] = "home",
): LiveSetup => ({ round: 1, userSide, home, away, states: {} });

/** No cards, injuries, fatigue or AI substitutions: no change points at all. */
const QUIET: LiveModel = {
	...LIVE_MODEL,
	fatiguePer90: 0,
	aiFatigueSubs: 0,
	state: { ...STATE_MODEL, yellowBase: 0, redBase: 0, injuryRate: 0 },
};

const firstSeed = (pred: (seed: number) => boolean, from = 1): number => {
	for (let s = from; s < from + 5000; s++) if (pred(s)) return s;
	throw new Error("no seed found");
};

const H = teamOf(LEAGUE.squads, 10);
const A = teamOf(LEAGUE.squads, 11);
const starter = (t: LiveTeam, i: number) => {
	const p = t.eleven[i];
	if (!p) throw new Error("empty slot");
	return p.playerId;
};
const benchAt = (t: LiveTeam, i: number) => {
	const p = t.bench[i];
	if (!p) throw new Error("short bench");
	return p.playerId;
};
const sub = (minute: number, out: number, inId: number): LiveChange => ({
	minute,
	by: "player",
	kind: "sub",
	out,
	in: inId,
});

describe("determinizm i stabilnosc (1.2)", () => {
	it("ten sam setup, seed i zmiany daja identyczna os czasu", () => {
		const changes = [sub(55, starter(H, 9), benchAt(H, 0))];
		const a = playLive(setupOf(H, A), 42, changes, 90);
		const b = playLive(setupOf(H, A), 42, changes, 90);
		expect(a).toEqual(b);
		expect(playLive(setupOf(H, A), 43, changes, 90).events).not.toEqual(
			a.events,
		);
	});

	it("zdarzenia do minuty zmiany sa identyczne z wariantem bez zmiany", () => {
		let checked = 0;
		for (let seed = 1; seed <= 200; seed++) {
			const base = playLive(setupOf(H, A), seed, [], 90);
			for (const [minute, change] of [
				[60, sub(60, starter(H, 5), benchAt(H, 0))],
				[
					30,
					{
						minute: 30,
						by: "player",
						kind: "tactic",
						formation: "4-3-3",
						style: "attacking",
					},
				],
			] as const) {
				if (!validateChange(setupOf(H, A), seed, [], change).ok) continue;
				const changed = playLive(setupOf(H, A), seed, [change], 90);
				const upToChange = (r: typeof base) =>
					r.events.filter(
						(e) =>
							e.minute < minute ||
							(e.minute === minute && e.kind !== "sub" && e.kind !== "tactic"),
					);
				expect(upToChange(changed)).toEqual(upToChange(base));
				checked++;
			}
		}
		expect(checked).toBeGreaterThan(300);
	});

	it("odczyt do minuty m to prefiks pelnego meczu", () => {
		const full = playLive(setupOf(H, A), 7, [], 90);
		const half = playLive(setupOf(H, A), 7, [], 45);
		expect(half.events).toEqual(full.events.filter((e) => e.minute <= 45));
		expect(half.finished).toBe(false);
		expect(half.outcome).toBeUndefined();
		expect(full.finished).toBe(true);
		expect(full.events.at(-1)?.kind).toBe("full-time");
		expect(full.events.some((e) => e.kind === "half-time")).toBe(true);
	});
});

describe("zgodnosc z batchem bez punktow zmiany (1.3)", () => {
	it("3000 meczow: srednia goli i % gospodarzy w ±3% od simulateMatchRatings", () => {
		const N = 3000;
		let goals = 0;
		let homeWins = 0;
		let expGoals = 0;
		let expHome = 0;
		for (let i = 0; i < N; i++) {
			const f = LEAGUE.fixtures[i % LEAGUE.fixtures.length];
			if (!f) continue;
			const home = teamOf(LEAGUE.squads, f.homeClubId);
			const away = teamOf(LEAGUE.squads, f.awayClubId);
			const r = playLive(
				setupOf(home, away, null),
				deriveSeed(3, i),
				[],
				90,
				QUIET,
			);
			expect(
				r.events.every((e) =>
					["goal", "half-time", "full-time"].includes(e.kind),
				),
			).toBe(true);
			goals += r.score.home + r.score.away;
			if (r.score.home > r.score.away) homeWins++;
			const slots = (t: LiveTeam) =>
				FORMATIONS[t.tactic.formation].map((role, j) => ({
					role,
					player: t.eleven[j] ?? null,
				}));
			const l = expectedGoalsRatings(
				teamRatings(slots(home), home.tactic),
				teamRatings(slots(away), away.tactic),
			);
			const grid = scoreProbabilities(l.home, l.away, QUIET.match.drawRho);
			grid.forEach((row, x) => {
				row.forEach((p, y) => {
					expGoals += p * (x + y);
					if (x > y) expHome += p;
				});
			});
		}
		expect(Math.abs(goals / expGoals - 1)).toBeLessThan(0.03);
		expect(Math.abs(homeWins / expHome - 1)).toBeLessThan(0.03);
	});
});

describe("realizm z AI po obu stronach (1.4)", () => {
	it("3000 meczow PL-podobnych: gole, gospodarze i remisy w zakresach PRD", () => {
		const s = liveStats(LEAGUE.squads, LEAGUE.fixtures, 3000, 11);
		expect(s.goalsPerMatch).toBeGreaterThanOrEqual(GOALS_RANGE[0]);
		expect(s.goalsPerMatch).toBeLessThanOrEqual(GOALS_RANGE[1]);
		expect(s.homeWinPct).toBeGreaterThanOrEqual(HOME_WIN_PCT_RANGE[0]);
		expect(s.homeWinPct).toBeLessThanOrEqual(HOME_WIN_PCT_RANGE[1]);
		expect(s.drawPct).toBeGreaterThanOrEqual(DRAW_PCT_RANGE[0]);
		expect(s.drawPct).toBeLessThanOrEqual(DRAW_PCT_RANGE[1]);
		expect(s.injuriesPerMatch).toBeGreaterThan(1);
		expect(s.yellowsPerMatch).toBeGreaterThan(3);
	});
});

describe("kierunek: zmiany zmeczonych od 60' (1.5)", () => {
	it("druzyna robiaca zmiany ma wyzsza srednia roznice bramek niz bez zmian", () => {
		// A deep bench (2 points below the starters): fresh substitutes beat tired starters from ~60'.
		const { squads, fixtures } = league(2);
		const N = 3000;
		let withSubs = 0;
		let without = 0;
		let fatigueSubs = 0;
		for (let i = 0; i < N; i++) {
			const f = fixtures[i % fixtures.length];
			if (!f) continue;
			const home = teamOf(squads, f.homeClubId);
			const away = teamOf(squads, f.awayClubId);
			const seed = deriveSeed(5, i);
			const ai = playLive(setupOf(home, away, null), seed, [], 90);
			withSubs += ai.score.home - ai.score.away;
			fatigueSubs += ai.events.filter(
				(e) => e.kind === "sub" && e.side === "home" && e.minute >= 60,
			).length;
			const user = setupOf(home, away, "home");
			const changes = injuryAutoSubs(user, seed, [], 90);
			const passive = playLive(user, seed, changes, 90);
			without += passive.score.home - passive.score.away;
		}
		expect(fatigueSubs / N).toBeGreaterThan(1);
		expect(withSubs / N).toBeGreaterThan(without / N + 0.015);
	});
});

describe("reguly zmian (1.6)", () => {
	const setup = setupOf(H, A);

	it("limit 5 zmian", () => {
		const changes: LiveChange[] = [];
		for (let k = 0; k < 5; k++) {
			const c = sub(10 + k, starter(H, 1 + k), benchAt(H, k));
			expect(validateChange(setup, 1, changes, c)).toEqual({ ok: true });
			changes.push(c);
		}
		const sixth = sub(20, starter(H, 7), benchAt(H, 5));
		const v = validateChange(setup, 1, changes, sixth);
		expect(v.ok).toBe(false);
		if (!v.ok) {
			expect(v.error).toEqual({ code: "subsLimit", params: { max: 5 } });
		}
		expect(playLive(setup, 1, changes, 20).subsLeft.home).toBe(0);
	});

	it("zawodnik po zejsciu nie wraca, schodzacy musi byc na boisku", () => {
		const out = starter(H, 9);
		const first = sub(30, out, benchAt(H, 0));
		const back = validateChange(
			setup,
			1,
			[first],
			sub(40, starter(H, 10), out),
		);
		expect(back.ok).toBe(false);
		if (!back.ok) expect(back.error).toEqual({ code: "subInNotOnBench" });
		const gone = validateChange(setup, 1, [first], sub(40, out, benchAt(H, 1)));
		expect(gone.ok).toBe(false);
		if (!gone.ok) expect(gone.error).toEqual({ code: "subOutNotOnPitch" });
	});

	it("zmiana tylko w biezacej minucie < 90 i nie przed poprzednia", () => {
		const late = validateChange(
			setup,
			1,
			[],
			sub(90, starter(H, 9), benchAt(H, 0)),
		);
		expect(late.ok).toBe(false);
		if (!late.ok) expect(late.error).toEqual({ code: "matchOver" });
		const first = sub(50, starter(H, 9), benchAt(H, 0));
		expect(
			validateChange(setup, 1, [first], sub(40, starter(H, 8), benchAt(H, 1)))
				.ok,
		).toBe(false);
		expect(
			validateChange(
				setupOf(H, A, null),
				1,
				[],
				sub(10, starter(H, 9), benchAt(H, 0)),
			).ok,
		).toBe(false);
	});

	it("czerwona kartka: 10 na boisku i nizsze λ", () => {
		const reds: LiveModel = {
			...QUIET,
			state: { ...QUIET.state, redBase: 0.05 },
		};
		const seed = firstSeed((s) =>
			playLive(setup, s, [], 90, reds).events.some(
				(e) => e.kind === "red" && e.side === "home" && e.minute < 88,
			),
		);
		const red = playLive(setup, seed, [], 90, reds).events.find(
			(e) => e.kind === "red" && e.side === "home",
		);
		const m = red?.minute ?? 0;
		const before = playLive(setup, seed, [], m - 1, reds);
		const after = playLive(setup, seed, [], m, reds);
		const filled = (r: typeof after) =>
			r.onPitch.home.filter((s) => s.playerId !== null).length;
		expect(filled(before)).toBe(11);
		expect(filled(after)).toBe(10);
		expect(after.sides.home.lambda).toBeLessThan(before.sides.home.lambda);
		expect(after.sides.away.lambda).toBeGreaterThan(before.sides.away.lambda);
		// A dismissed player cannot be replaced.
		const v = validateChange(
			setup,
			seed,
			[],
			sub(m, red?.playerId ?? 0, benchAt(H, 0)),
			reds,
		);
		expect(v.ok).toBe(false);
	});

	const injuries: LiveModel = {
		...QUIET,
		state: { ...QUIET.state, injuryRate: 0.3 },
	};

	it("kontuzja rywala: zmiana AI w tej samej minucie", () => {
		const seed = firstSeed((s) =>
			playLive(setup, s, [], 90, injuries).events.some(
				(e) => e.kind === "injury" && e.side === "away",
			),
		);
		const r = playLive(setup, seed, [], 90, injuries);
		const injury = r.events.find(
			(e) => e.kind === "injury" && e.side === "away",
		);
		const subEvent = r.events.find(
			(e) =>
				e.kind === "sub" &&
				e.side === "away" &&
				e.playerId === injury?.playerId,
		);
		expect(subEvent?.minute).toBe(injury?.minute);
		expect(subEvent?.by).toBe("ai");
		const at = playLive(setup, seed, [], injury?.minute ?? 0, injuries);
		expect(at.onPitch.away.filter((s) => s.playerId !== null).length).toBe(11);
	});

	it("kontuzja zawodnika gracza: 10 na boisku, potem jawna zmiana AI w minucie kontuzji", () => {
		const seed = firstSeed((s) =>
			playLive(setup, s, [], 90, injuries).events.some(
				(e) => e.kind === "injury" && e.side === "home" && e.minute < 85,
			),
		);
		const injury = playLive(setup, seed, [], 90, injuries).events.find(
			(e) => e.kind === "injury" && e.side === "home",
		);
		const m = injury?.minute ?? 0;
		const id = injury?.playerId ?? 0;
		const paused = playLive(setup, seed, [], m, injuries);
		expect(paused.onPitch.home.filter((s) => s.playerId !== null).length).toBe(
			10,
		);
		expect(paused.sides.home.vacancies).toContain(id);
		expect(injuryAutoSubs(setup, seed, [], m, injuries)).toEqual([]);
		// The user can replace the injured player himself at m.
		expect(
			validateChange(setup, seed, [], sub(m, id, benchAt(H, 0)), injuries).ok,
		).toBe(true);
		const changes = injuryAutoSubs(setup, seed, [], m + 1, injuries);
		const ai = changes.find((c) => c.kind === "sub" && c.out === id);
		expect(ai).toMatchObject({ minute: m, by: "ai", kind: "sub", out: id });
		const resumed = playLive(setup, seed, changes, m, injuries);
		expect(resumed.onPitch.home.filter((s) => s.playerId !== null).length).toBe(
			11,
		);
		expect(resumed.sides.home.vacancies).not.toContain(id);
	});

	it("zmiana formacji i stylu: zdarzenie w relacji, styl ofensywny podnosi λ", () => {
		const change: LiveChange = {
			minute: 20,
			by: "player",
			kind: "tactic",
			formation: "4-3-3",
			style: "attacking",
		};
		const before = playLive(setup, 3, [], 20, QUIET);
		const after = playLive(setup, 3, [change], 20, QUIET);
		expect(after.events.at(-1)).toMatchObject({
			kind: "tactic",
			formation: "4-3-3",
		});
		expect(after.sides.home.tactic).toEqual({
			formation: "4-3-3",
			style: "attacking",
		});
		expect(after.onPitch.home.map((s) => s.role)).toEqual(FORMATIONS["4-3-3"]);
		expect(after.sides.home.lambda).toBeGreaterThan(before.sides.home.lambda);
	});
});

describe("przerzedzanie: zmiana λ zmienia gole po zmianie", () => {
	it("styl defensywny od 1' daje mniej goli gospodarzy, ofensywny wiecej (3000 meczow)", () => {
		const N = 3000;
		const setup = setupOf(H, A, "home");
		const style = (s: "attacking" | "defensive"): LiveChange[] => [
			{
				minute: 1,
				by: "player",
				kind: "tactic",
				formation: H.tactic.formation,
				style: s,
			},
		];
		const meanHome = (changes: LiveChange[]) => {
			let goals = 0;
			for (let i = 0; i < N; i++) {
				const seed = deriveSeed(17, i);
				goals += playLive(setup, seed, changes, 90, QUIET).score.home;
			}
			return goals / N;
		};
		const base = meanHome([]);
		const defensive = meanHome(style("defensive"));
		const attacking = meanHome(style("attacking"));
		expect(defensive).toBeLessThan(base * 0.95);
		expect(attacking).toBeGreaterThan(base * 1.05);
	}, 30_000);
});

describe("przerzedzanie: zmiana neutralna dla λ (1.9)", () => {
	it("20000 meczow: % remisow rozni sie o mniej niz 0,7 pp", () => {
		const N = 20000;
		const homeBase = teamOf(LEAGUE.squads, 10);
		const cm = homeBase.eleven[5];
		if (!cm) throw new Error("no CM");
		// Twin coming on at 60' with the starter's value at 60' (linear fatigue from 100 fitness): neutral.
		const twin: PlayerAttributes = {
			...cm,
			playerId: 999_001,
			overall: cm.overall - (LIVE_MODEL.fatiguePer90 * 60) / 90,
		};
		const home = { ...homeBase, bench: [twin, ...homeBase.bench.slice(0, 8)] };
		const setup = setupOf(home, A, "home");
		const swap = [sub(60, cm.playerId, twin.playerId)];
		const at61 = (changes: LiveChange[]) =>
			playLive(setup, 1, changes, 61).sides.home.lambda;
		expect(at61(swap)).toBeCloseTo(at61([]), 10);
		let drawsBase = 0;
		let drawsSwap = 0;
		for (let i = 0; i < N; i++) {
			const seed = deriveSeed(9, i);
			const a = playLive(setup, seed, [], 90);
			const b = playLive(setup, seed, swap, 90);
			if (a.score.home === a.score.away) drawsBase++;
			if (b.score.home === b.score.away) drawsSwap++;
		}
		expect(Math.abs(drawsBase - drawsSwap) / N).toBeLessThan(0.007);
	}, 30_000);
});

describe("stan po meczu", () => {
	it("tylko przy 90': kondycja proporcjonalna do minut, forma wg wyniku", () => {
		const changes = [sub(60, starter(H, 9), benchAt(H, 0))];
		const r = playLive(setupOf(H, A), 5, changes, 90, QUIET);
		const outcome = r.outcome;
		if (!outcome) throw new Error("no outcome");
		expect(outcome.played).toHaveLength(23);
		const out = outcome.players.find((p) => p.playerId === starter(H, 9));
		const inP = outcome.players.find((p) => p.playerId === benchAt(H, 0));
		expect(out?.minutes).toBe(60);
		expect(inP?.minutes).toBe(30);
		expect(out?.state.fitness).toBeCloseTo(
			100 - (STATE_MODEL.fitnessCost * 60) / 90,
			10,
		);
		expect(inP?.state.fitness).toBeCloseTo(
			100 - (STATE_MODEL.fitnessCost * 30) / 90,
			10,
		);
		const result = Math.sign(r.score.home - r.score.away);
		expect(Math.sign(out?.state.form ?? 0)).toBe(result);
		expect(outcome.players.some((p) => p.playerId === benchAt(H, 1))).toBe(
			false,
		);
	});

	it("strzelec gola jest na boisku jego druzyny", () => {
		for (let seed = 1; seed <= 50; seed++) {
			const r = playLive(setupOf(H, A), seed, [], 90);
			for (const g of r.events.filter((e) => e.kind === "goal")) {
				const team = g.side === "home" ? H : A;
				const ids = [...team.eleven, ...team.bench].map((p) => p?.playerId);
				expect(ids).toContain(g.playerId);
			}
		}
	});
});

describe("przejecie meczu przez AI (exit-and-resume, faza 1)", () => {
	const setup = setupOf(H, A);
	const takeover = (minute: number): LiveChange => ({
		minute,
		by: "ai",
		kind: "takeover",
	});
	const injuries: LiveModel = {
		...QUIET,
		state: { ...QUIET.state, injuryRate: 0.3 },
	};
	// A deep bench (2 points below the starters): the AI makes fatigue subs from 60'.
	const DEEP = league(2);
	const HD = teamOf(DEEP.squads, 10);
	const AD = teamOf(DEEP.squads, 11);
	const deep = setupOf(HD, AD);
	const homeSubs = (r: ReturnType<typeof playLive>) =>
		r.events.filter((e) => e.kind === "sub" && e.side === "home");
	const injuredHome = (r: ReturnType<typeof playLive>) =>
		new Set(
			r.events
				.filter((e) => e.kind === "injury" && e.side === "home")
				.map((e) => e.playerId),
		);

	it("zdarzenia przed minuta przejecia i inne niz zmiany w tej minucie sa jak bez przejecia; wynik deterministyczny", () => {
		let checked = 0;
		for (let seed = 1; seed <= 200; seed++) {
			const base = playLive(setup, seed, [], 90);
			for (const m of [30, 70]) {
				const changes = [takeover(m)];
				const taken = playLive(setup, seed, changes, 90);
				const upTo = (r: typeof base) =>
					r.events.filter(
						(e) => e.minute < m || (e.minute === m && e.kind !== "sub"),
					);
				expect(upTo(taken)).toEqual(upTo(base));
				expect(
					taken.events.some((e) => (e.kind as string) === "takeover"),
				).toBe(false);
				checked++;
			}
		}
		expect(checked).toBe(400);
		const a = playLive(setup, 42, [takeover(30)], 90);
		expect(playLive(setup, 42, [takeover(30)], 90)).toEqual(a);
	});

	it("po przejeciu AI robi zmiany zmeczonych od 60' po stronie gracza", () => {
		let fatigue = 0;
		for (let seed = 1; seed <= 30; seed++) {
			expect(homeSubs(playLive(deep, seed, [], 90))).toHaveLength(0);
			const r = playLive(deep, seed, [takeover(30)], 90);
			const injured = injuredHome(r);
			const subs = homeSubs(r).filter((e) => !injured.has(e.playerId));
			for (const e of subs) {
				expect(e.by).toBe("ai");
				expect(e.minute).toBeGreaterThanOrEqual(LIVE_MODEL.aiSubFrom);
			}
			expect(subs.length).toBeLessThanOrEqual(LIVE_MODEL.aiFatigueSubs);
			fatigue += subs.length;
		}
		expect(fatigue).toBeGreaterThanOrEqual(1);
	});

	it("po przejeciu kontuzjowany jest zmieniany w tej samej minucie, injuryAutoSubs nic nie dodaje", () => {
		const firstHomeInjury = (s: number) =>
			playLive(setup, s, [], 90, injuries).events.find(
				(e) => e.kind === "injury" && e.side === "home",
			);
		const seed = firstSeed((s) => {
			const i = firstHomeInjury(s);
			return i !== undefined && i.minute > 5 && i.minute < 85;
		});
		const injury = firstHomeInjury(seed);
		const m = injury?.minute ?? 0;
		const changes = [takeover(m - 3)];
		const r = playLive(setup, seed, changes, 90, injuries);
		expect(
			r.events.find((e) => e.kind === "injury" && e.side === "home"),
		).toEqual(injury);
		const replaced = homeSubs(r).find((e) => e.playerId === injury?.playerId);
		expect(replaced).toMatchObject({ minute: m, by: "ai" });
		const at = playLive(setup, seed, changes, m, injuries);
		expect(at.onPitch.home.filter((s) => s.playerId !== null).length).toBe(11);
		expect(at.sides.home.vacancies).toEqual([]);
		expect(injuryAutoSubs(setup, seed, changes, 90, injuries)).toBe(changes);
	});

	it("wolne miejsce z chwili przejecia jest uzupelnione w minucie przejecia", () => {
		const seed = firstSeed((s) =>
			playLive(setup, s, [], 90, injuries).events.some(
				(e) => e.kind === "injury" && e.side === "home" && e.minute < 80,
			),
		);
		const injury = playLive(setup, seed, [], 90, injuries).events.find(
			(e) => e.kind === "injury" && e.side === "home",
		);
		const k = injury?.minute ?? 0;
		const id = injury?.playerId ?? 0;
		const t = k + 3;
		const changes = [takeover(t)];
		expect(
			playLive(setup, seed, changes, t - 1, injuries).sides.home.vacancies,
		).toContain(id);
		const at = playLive(setup, seed, changes, t, injuries);
		expect(at.sides.home.vacancies).toEqual([]);
		expect(homeSubs(at).find((e) => e.playerId === id)).toMatchObject({
			minute: t,
			by: "ai",
		});
		expect(at.subsLeft.home).toBeLessThan(LIVE_MODEL.maxSubs);
		// Injury exactly in the takeover minute: filled at once, nothing left for injuryAutoSubs.
		const same = [takeover(k)];
		const atK = playLive(setup, seed, same, k, injuries);
		expect(atK.sides.home.vacancies).toEqual([]);
		expect(homeSubs(atK).find((e) => e.playerId === id)).toMatchObject({
			minute: k,
			by: "ai",
		});
		expect(injuryAutoSubs(setup, seed, same, 90, injuries)).toBe(same);
	});

	it("limit 5 zmian liczony razem ze zmianami gracza sprzed przejecia", () => {
		const userSubs = (n: number) =>
			Array.from({ length: n }, (_, k) =>
				sub(10 + k, starter(HD, 1 + k), benchAt(HD, k)),
			);
		let reachedLimit = 0;
		for (let seed = 1; seed <= 30; seed++) {
			const four = playLive(deep, seed, [...userSubs(4), takeover(20)], 90);
			expect(homeSubs(four).length).toBeLessThanOrEqual(LIVE_MODEL.maxSubs);
			if (homeSubs(four).length === LIVE_MODEL.maxSubs) {
				expect(four.subsLeft.home).toBe(0);
				const last = homeSubs(four).at(-1);
				// The limit is reached by an AI fatigue sub after the takeover.
				if (
					last?.by === "ai" &&
					last.minute >= LIVE_MODEL.aiSubFrom &&
					!injuredHome(four).has(last.playerId)
				) {
					reachedLimit++;
				}
			}
			const five = playLive(deep, seed, [...userSubs(5), takeover(20)], 90);
			expect(homeSubs(five)).toHaveLength(LIVE_MODEL.maxSubs);
			expect(homeSubs(five).every((e) => e.by === "player")).toBe(true);
		}
		expect(reachedLimit).toBeGreaterThanOrEqual(1);
	});

	it("reguly: przejecie przy userSide null, drugie przejecie i zmiana gracza po przejeciu sa odrzucane", () => {
		expect(validateChange(setup, 1, [], takeover(30))).toEqual({ ok: true });
		const noUser = validateChange(setupOf(H, A, null), 1, [], takeover(30));
		expect(noUser.ok).toBe(false);
		const taken = [takeover(30)];
		for (const change of [
			takeover(30),
			takeover(40),
			sub(30, starter(H, 9), benchAt(H, 0)),
			sub(40, starter(H, 9), benchAt(H, 0)),
			{
				minute: 40,
				by: "player",
				kind: "tactic",
				formation: "4-3-3",
				style: "attacking",
			} as const,
		]) {
			const v = validateChange(setup, 1, taken, change);
			expect(v).toEqual({ ok: false, error: { code: "aiInCharge" } });
		}
		// A stored user change after the takeover is ignored by the replay.
		const ignored = playLive(
			setup,
			1,
			[...taken, sub(40, starter(H, 9), benchAt(H, 0))],
			90,
			QUIET,
		);
		expect(homeSubs(ignored).some((e) => e.by === "player")).toBe(false);
	});
});
