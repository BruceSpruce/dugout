// Live match minute by minute: a deterministic replay of (setup, seed, changes) up to a minute,
// with an AI coach, in-match fatigue, player events and goals thinned against the kickoff score.
// Pure module: no imports outside src/engine/ (runs from the CLI for calibration).

import type { PlayerAttributes } from "./attributes";
import {
	expectedGoalsRatings,
	MATCH_MODEL,
	type MatchModel,
	type Ratings,
	simulateMatchRatings,
} from "./match";
import {
	applyLiveOutcome,
	drawInjuryDuration,
	eventProbabilities,
	freshState,
	type PlayerState,
	type RedCard,
	STATE_MODEL,
	type StateModel,
	updateForm,
} from "./player-state";
import { createRng, poisson, type Rng } from "./rng";
import {
	bestElevenFor,
	effectiveSlotOverall,
	FORMATIONS,
	type FormationId,
	type Role,
	type Slot,
	type Style,
	TACTICS_MODEL,
	type Tactic,
	teamRatings,
} from "./tactics";

export type LiveModel = {
	/** Points a player loses over 90 minutes on the pitch at pre-match fitness 100 (subtractive). */
	fatiguePer90: number;
	/** Extra fatigue rate at pre-match fitness 0: rate x (1 + this x (100 - fitness) / 100). */
	fatigueLowFitness: number;
	/** First minute in which the AI coach makes fatigue substitutions. */
	aiSubFrom: number;
	/** Minimum minutes between two AI fatigue substitutions of one side. */
	aiSubGap: number;
	/** Fatigue substitutions per AI side (injury substitutions do not count). */
	aiFatigueSubs: number;
	/** A fatigue substitution needs the bench player to be better by more than this many points. */
	aiSubMargin: number;
	/** Substitutions per side per match. */
	maxSubs: number;
	/** Bench size of an AI lineup. */
	benchSize: number;
	/** λ(m) is capped at extraCap x λ₀; extra goal candidates run at (extraCap - 1) x λ₀. */
	extraCap: number;
	match: MatchModel;
	state: StateModel;
};

/**
 * Tuned 2026-11-15 on PL 2024 (`npm run live:calibration -- --league 39 --season 2024`, 3800 matches,
 * seed 1, AI on both sides, freshState): goals 2.59 (kickoff score 2.62), home wins 44.3% (42.8),
 * draws 25.3% (24.1), subs 5.20, yellows 4.10, reds 0.139, injuries 1.45 per match. fatiguePer90 6 -> 10
 * so that fresh substitutes matter (same gates within 0.1); aiSubMargin 0 -> 1 stopped swaps of equal
 * players. Synthetic test league (1.4): goals 2.61, home 44.8%, draws 24.2%.
 */
export const LIVE_MODEL: LiveModel = {
	fatiguePer90: 10,
	fatigueLowFitness: 1,
	aiSubFrom: 60,
	aiSubGap: 5,
	aiFatigueSubs: 3,
	aiSubMargin: 1,
	maxSubs: 5,
	benchSize: 9,
	extraCap: 2,
	match: MATCH_MODEL,
	state: STATE_MODEL,
};

export type Side = "home" | "away";

export type LiveTeam = {
	clubId: number;
	tactic: Tactic;
	/** One entry per slot of FORMATIONS[tactic.formation], in slot order; null = empty slot. */
	eleven: (PlayerAttributes | null)[];
	bench: PlayerAttributes[];
};

export type LiveSetup = {
	round: number;
	/** The side the user coaches; null = AI coaches both sides (calibration, tests). */
	userSide: Side | null;
	home: LiveTeam;
	away: LiveTeam;
	/** Pre-match state (after beforeRound) per playerId; overall in the teams is already effectiveOverall. Missing = freshState. */
	states: Record<number, PlayerState>;
};

export type LiveChange =
	| {
			minute: number;
			by: "player" | "ai";
			kind: "sub";
			out: number;
			in: number;
	  }
	| {
			minute: number;
			by: "player";
			kind: "tactic";
			formation: FormationId;
			style: Style;
	  };

export type LiveEventKind =
	| "goal"
	| "yellow"
	| "second-yellow"
	| "red"
	| "injury"
	| "sub"
	| "tactic"
	| "half-time"
	| "full-time";

export type LiveEvent = {
	minute: number;
	/** null for half-time / full-time. */
	side: Side | null;
	kind: LiveEventKind;
	/** Scorer, carded or injured player, player going off (sub); null for half-time / full-time / tactic. */
	playerId: number | null;
	/** Player coming on (sub). */
	inPlayerId?: number;
	/** Who made the substitution. */
	by?: "player" | "ai";
	formation?: FormationId;
	style?: Style;
};

export type LiveSlot = {
	role: Role;
	playerId: number | null;
	/** Current value on the pitch: pre-match overall minus in-match fatigue (0 for an empty slot). */
	value: number;
};

export type LivePlayerOutcome = {
	playerId: number;
	clubId: number;
	minutes: number;
	yellow: boolean;
	red: RedCard;
	/** Injury length in matches, 0 = none. */
	injured: number;
	state: PlayerState;
};

export type LiveOutcome = {
	/** Post-match state of every player who played (cards, injury, fitness x minutes, form). */
	players: LivePlayerOutcome[];
	/** Player ids who were on the pitch, home first. */
	played: number[];
};

export type LiveSideView = {
	slots: LiveSlot[];
	tactic: Tactic;
	/** Bench players still able to come on. */
	bench: number[];
	subsLeft: number;
	/** Injured players who left with their slot still empty (a sub may replace them). */
	vacancies: number[];
	/** Expected goals per 90 at the current lineups (for the next minute). */
	lambda: number;
};

export type LiveResult = {
	minute: number;
	events: LiveEvent[];
	score: { home: number; away: number };
	onPitch: { home: LiveSlot[]; away: LiveSlot[] };
	subsLeft: { home: number; away: number };
	sides: { home: LiveSideView; away: LiveSideView };
	finished: boolean;
	outcome?: LiveOutcome;
};

export const FULL_TIME = 90;
const HALF_TIME = 45;

// --- rng sub-streams ---------------------------------------------------------------------

const STREAM_SCORE = 1;
const STREAM_GOALS = 2;
const STREAM_EXTRA = 3;
const STREAM_PLAYER = 4;

function mix(h: number, x: number): number {
	let v = Math.imul(h ^ (x >>> 0), 0x9e3779b1);
	v ^= v >>> 16;
	v = Math.imul(v, 0x85ebca6b);
	v ^= v >>> 13;
	v = Math.imul(v, 0xc2b2ae35);
	v ^= v >>> 16;
	return v >>> 0;
}

/** Seed of an independent sub-stream of a match seed (e.g. per side, per player). */
export function deriveSeed(seed: number, ...keys: number[]): number {
	let h = mix(0x811c9dc5, seed);
	for (const k of keys) h = mix(h, k);
	return h;
}

const streamOf = (seed: number, ...keys: number[]): Rng =>
	createRng(deriveSeed(seed, ...keys));

const sideKey = (side: Side) => (side === "home" ? 0 : 1);

/** Minute uniform in (from, 90]. */
const minuteAfter = (from: number, u: number) =>
	from + 1 + Math.floor(u * (FULL_TIME - from));

// --- AI lineup ------------------------------------------------------------------------------

/** AI lineup: best eleven for the tactic and the `benchSize` best remaining players by overall. */
export function aiLiveTeam(
	clubId: number,
	available: PlayerAttributes[],
	tactic: Tactic,
	benchSize: number = LIVE_MODEL.benchSize,
): LiveTeam {
	const eleven = bestElevenFor(available, tactic.formation).map(
		(s) => s.player,
	);
	const taken = new Set(eleven.flatMap((p) => (p ? [p.playerId] : [])));
	const bench = available
		.filter((p) => !taken.has(p.playerId))
		.sort((a, b) => b.overall - a.overall || a.playerId - b.playerId)
		.slice(0, benchSize);
	return { clubId, tactic, eleven, bench };
}

// --- replay ---------------------------------------------------------------------------------

type Timeline = {
	entry: number;
	yellow?: number;
	secondYellow?: number;
	red?: number;
	injury?: number;
	injuryLength: number;
};

type PlayerLog = {
	entry: number;
	exit?: number;
	yellow: boolean;
	red: RedCard;
	injured: number;
};

type SlotState = { role: Role; playerId: number | null };

type SideState = {
	side: Side;
	team: LiveTeam;
	ai: boolean;
	tactic: Tactic;
	slots: SlotState[];
	bench: number[];
	subsUsed: number;
	aiFatigueSubs: number;
	lastAiSub: number;
	vacancies: number[];
	lambda0: number;
	/** Best bench player per role; bench players are fresh, so it changes only with the bench. */
	bestCache: Map<Role, { id: number; value: number } | null>;
};

type GoalCandidate = {
	minute: number;
	/** Keep (initial goal) or accept (extra) uniform. */
	u: number;
	/** Scorer uniform. */
	w: number;
	extra: boolean;
};

class Replay {
	readonly players = new Map<number, PlayerAttributes>();
	readonly clubOf = new Map<number, number>();
	readonly timelines = new Map<number, Timeline>();
	readonly logs = new Map<number, PlayerLog>();
	readonly events: LiveEvent[] = [];
	/** Minutes with at least one drawn player event (skips quiet minutes). */
	private readonly eventMinutes = new Set<number>();
	readonly score = { home: 0, away: 0 };
	readonly home: SideState;
	readonly away: SideState;
	readonly goals: { home: GoalCandidate[]; away: GoalCandidate[] };

	constructor(
		readonly setup: LiveSetup,
		readonly seed: number,
		readonly model: LiveModel,
	) {
		for (const team of [setup.home, setup.away]) {
			for (const p of [...team.eleven, ...team.bench]) {
				if (!p) continue;
				this.players.set(p.playerId, p);
				this.clubOf.set(p.playerId, team.clubId);
			}
		}
		this.home = this.sideState("home", setup.home);
		this.away = this.sideState("away", setup.away);
		for (const s of [this.home, this.away]) {
			for (const slot of s.slots) {
				if (slot.playerId !== null) this.enter(slot.playerId, 0);
			}
		}
		const r0home = this.ratings(this.home, 0);
		const r0away = this.ratings(this.away, 0);
		const lambda0 = expectedGoalsRatings(r0home, r0away, model.match);
		this.home.lambda0 = lambda0.home;
		this.away.lambda0 = lambda0.away;
		const kickoff = simulateMatchRatings(
			r0home,
			r0away,
			streamOf(seed, STREAM_SCORE),
			model.match,
		);
		this.goals = {
			home: this.candidates("home", kickoff.homeGoals, lambda0.home),
			away: this.candidates("away", kickoff.awayGoals, lambda0.away),
		};
	}

	private sideState(side: Side, team: LiveTeam): SideState {
		const roles = FORMATIONS[team.tactic.formation];
		return {
			side,
			team,
			ai: this.setup.userSide !== side,
			tactic: team.tactic,
			slots: roles.map((role, i) => ({
				role,
				playerId: team.eleven[i]?.playerId ?? null,
			})),
			bench: team.bench.map((p) => p.playerId),
			subsUsed: 0,
			aiFatigueSubs: 0,
			lastAiSub: Number.NEGATIVE_INFINITY,
			vacancies: [],
			lambda0: 0,
			bestCache: new Map(),
		};
	}

	/** Kickoff goals (minute, keep uniform, scorer uniform) plus extra candidates, from the side's streams. */
	private candidates(side: Side, n: number, lambda0: number): GoalCandidate[] {
		const out: GoalCandidate[] = [];
		const g = streamOf(this.seed, STREAM_GOALS, sideKey(side));
		for (let i = 0; i < n; i++) {
			const minute = minuteAfter(0, g());
			out.push({ minute, u: g(), w: g(), extra: false });
		}
		const e = streamOf(this.seed, STREAM_EXTRA, sideKey(side));
		const extras = poisson(e, Math.max(0, this.model.extraCap - 1) * lambda0);
		for (let i = 0; i < extras; i++) {
			const minute = minuteAfter(0, e());
			out.push({ minute, u: e(), w: e(), extra: true });
		}
		return out.sort((a, b) => a.minute - b.minute);
	}

	/** Player comes on at `minute` (0 = kickoff): draws his events for (minute, 90] from his own stream. */
	private enter(playerId: number, minute: number) {
		const player = this.players.get(playerId);
		if (!player) return;
		const rng = streamOf(this.seed, STREAM_PLAYER, playerId);
		const p = eventProbabilities(player, this.model.state);
		const share = (FULL_TIME - minute) / FULL_TIME;
		const uYellow = rng();
		const uSecond = rng();
		const uRed = rng();
		const uInjury = rng();
		const mYellow = minuteAfter(minute, rng());
		const uSecondMinute = rng();
		const mRed = minuteAfter(minute, rng());
		const mInjury = minuteAfter(minute, rng());
		const injuryLength = drawInjuryDuration(rng, this.model.state);
		const t: Timeline = { entry: minute, injuryLength };
		if (uYellow < p.yellow * share) {
			t.yellow = mYellow;
			if (uSecond < p.secondYellowShare && mYellow < FULL_TIME) {
				t.secondYellow = minuteAfter(mYellow, uSecondMinute);
			}
		}
		if (t.secondYellow === undefined && uRed < p.red * share) t.red = mRed;
		if (uInjury < p.injury * share) t.injury = mInjury;
		for (const m of [t.yellow, t.secondYellow, t.red, t.injury]) {
			if (m !== undefined) this.eventMinutes.add(m);
		}
		this.timelines.set(playerId, t);
		this.logs.set(playerId, {
			entry: minute,
			yellow: false,
			red: "none",
			injured: 0,
		});
	}

	private fitnessOf(playerId: number): number {
		return (this.setup.states[playerId] ?? freshState()).fitness;
	}

	/** Pre-match overall minus subtractive fatigue for the minutes played by `minute`. */
	value(playerId: number, minute: number): number {
		const p = this.players.get(playerId);
		if (!p) return 0;
		const entry = this.logs.get(playerId)?.entry ?? minute;
		const played = Math.max(0, minute - entry);
		const rate =
			this.model.fatiguePer90 *
			(1 +
				(this.model.fatigueLowFitness * (100 - this.fitnessOf(playerId))) /
					100);
		return Math.max(0, p.overall - (rate * played) / FULL_TIME);
	}

	/** effectiveSlotOverall of the player's current value in a slot of `role`, without copying. */
	slotValue(role: Role, playerId: number, minute: number): number {
		const p = this.players.get(playerId);
		if (!p) return 0;
		const v = this.value(playerId, minute);
		if (p.overall <= 0) return 0;
		// Same position factor as effectiveSlotOverall (1 in position, 0.8 outside).
		return (v * effectiveSlotOverall({ role, player: p })) / p.overall;
	}

	private slotsAt(s: SideState, minute: number): Slot[] {
		return s.slots.map((slot) => {
			const p =
				slot.playerId === null ? undefined : this.players.get(slot.playerId);
			return {
				role: slot.role,
				player:
					p && slot.playerId !== null
						? { ...p, overall: this.value(slot.playerId, minute) }
						: null,
			};
		});
	}

	ratings(s: SideState, minute: number): Ratings {
		return teamRatings(this.slotsAt(s, minute), s.tactic);
	}

	lambdas(minute: number): { home: number; away: number } {
		return expectedGoalsRatings(
			this.ratings(this.home, minute),
			this.ratings(this.away, minute),
			this.model.match,
		);
	}

	private sideOf(side: Side): SideState {
		return side === "home" ? this.home : this.away;
	}

	private push(e: LiveEvent) {
		this.events.push(e);
	}

	private scorer(s: SideState, w: number): number | null {
		const weighted: [number, number][] = [];
		let total = 0;
		for (const slot of s.slots) {
			if (slot.playerId === null) continue;
			const p = this.players.get(slot.playerId);
			if (!p) continue;
			const weight =
				(p.attack + 1) * TACTICS_MODEL.roleWeights[slot.role].attack;
			if (weight <= 0) continue;
			weighted.push([slot.playerId, weight]);
			total += weight;
		}
		if (total <= 0) {
			return s.slots.find((x) => x.playerId !== null)?.playerId ?? null;
		}
		let pick = w * total;
		for (const [id, weight] of weighted) {
			if (pick < weight) return id;
			pick -= weight;
		}
		return weighted[weighted.length - 1]?.[0] ?? null;
	}

	private goalsAt(minute: number) {
		const due = (s: Side) => this.goals[s].some((g) => g.minute === minute);
		if (!due("home") && !due("away")) return;
		const lambda = this.lambdas(minute);
		for (const side of ["home", "away"] as const) {
			const s = this.sideOf(side);
			const l0 = s.lambda0;
			const l = Math.min(lambda[side], this.model.extraCap * l0);
			for (const g of this.goals[side]) {
				if (g.minute !== minute) continue;
				const scored = g.extra
					? this.model.extraCap > 1 &&
						g.u < (l - l0) / ((this.model.extraCap - 1) * l0)
					: g.u < Math.min(1, l / l0);
				if (!scored) continue;
				this.score[side]++;
				this.push({
					minute,
					side,
					kind: "goal",
					playerId: this.scorer(s, g.w),
				});
			}
		}
	}

	/** Leaves the pitch (red, injury, sub): the slot is emptied, logs record the exit minute. */
	private leave(s: SideState, playerId: number, minute: number) {
		for (const slot of s.slots) {
			if (slot.playerId === playerId) slot.playerId = null;
		}
		const log = this.logs.get(playerId);
		if (log) log.exit = minute;
	}

	private playerEventsAt(minute: number) {
		if (!this.eventMinutes.has(minute)) return;
		for (const s of [this.home, this.away]) {
			for (const slot of [...s.slots]) {
				const id = slot.playerId;
				if (id === null) continue;
				const t = this.timelines.get(id);
				const log = this.logs.get(id);
				if (!t || !log) continue;
				if (t.yellow === minute) {
					log.yellow = true;
					this.push({ minute, side: s.side, kind: "yellow", playerId: id });
				}
				if (t.secondYellow === minute) {
					log.red = "second-yellow";
					this.push({
						minute,
						side: s.side,
						kind: "second-yellow",
						playerId: id,
					});
					this.leave(s, id, minute);
					continue;
				}
				if (t.red === minute) {
					log.red = "straight";
					this.push({ minute, side: s.side, kind: "red", playerId: id });
					this.leave(s, id, minute);
					continue;
				}
				if (t.injury === minute) {
					log.injured = t.injuryLength;
					this.push({ minute, side: s.side, kind: "injury", playerId: id });
					const index = s.slots.indexOf(slot);
					this.leave(s, id, minute);
					if (s.ai) this.aiInjurySub(s, index, id, minute);
					else s.vacancies.push(id);
				}
			}
		}
	}

	subsLeft(s: SideState): number {
		return Math.max(0, this.model.maxSubs - s.subsUsed);
	}

	/** Bench player with the best value in the slot (ties by bench order). */
	bestFor(
		s: SideState,
		role: Role,
		minute: number,
	): { id: number; value: number } | null {
		const cached = s.bestCache.get(role);
		if (cached !== undefined) return cached;
		let best: { id: number; value: number } | null = null;
		for (const id of s.bench) {
			const v = this.slotValue(role, id, minute);
			if (!best || v > best.value) best = { id, value: v };
		}
		s.bestCache.set(role, best);
		return best;
	}

	private substitute(
		s: SideState,
		slotIndex: number,
		outId: number,
		inId: number,
		minute: number,
		by: "player" | "ai",
	) {
		const slot = s.slots[slotIndex];
		if (!slot) return;
		if (slot.playerId === outId) this.leave(s, outId, minute);
		slot.playerId = inId;
		s.bench = s.bench.filter((id) => id !== inId);
		s.bestCache.clear();
		s.vacancies = s.vacancies.filter((id) => id !== outId);
		s.subsUsed++;
		this.enter(inId, minute);
		this.push({
			minute,
			side: s.side,
			kind: "sub",
			playerId: outId,
			inPlayerId: inId,
			by,
		});
	}

	private aiInjurySub(
		s: SideState,
		slotIndex: number,
		outId: number,
		minute: number,
	) {
		const slot = s.slots[slotIndex];
		if (!slot || this.subsLeft(s) === 0) return;
		const best = this.bestFor(s, slot.role, minute);
		if (!best) return;
		this.substitute(s, slotIndex, outId, best.id, minute, "ai");
	}

	private aiFatigueSubAt(s: SideState, minute: number) {
		if (
			!s.ai ||
			minute < this.model.aiSubFrom ||
			minute >= FULL_TIME ||
			s.aiFatigueSubs >= this.model.aiFatigueSubs ||
			this.subsLeft(s) === 0 ||
			minute - s.lastAiSub < this.model.aiSubGap
		) {
			return;
		}
		let pick: { index: number; out: number; in: number; gain: number } | null =
			null;
		for (const [index, slot] of s.slots.entries()) {
			if (slot.playerId === null) continue;
			const p = this.players.get(slot.playerId);
			// A player who came on is never taken off again by the AI.
			if (!p || (this.logs.get(slot.playerId)?.entry ?? 0) > 0) continue;
			const current = this.slotValue(slot.role, slot.playerId, minute);
			const best = this.bestFor(s, slot.role, minute);
			if (!best) continue;
			const gain = best.value - current;
			if (gain > this.model.aiSubMargin && (!pick || gain > pick.gain)) {
				pick = { index, out: slot.playerId, in: best.id, gain };
			}
		}
		if (!pick) return;
		this.substitute(s, pick.index, pick.out, pick.in, minute, "ai");
		s.aiFatigueSubs++;
		s.lastAiSub = minute;
	}

	/** Checks a change of the user's side against the state at the end of its minute; null = valid. */
	check(change: LiveChange, minute: number): string | null {
		const side = this.setup.userSide;
		if (side === null) return "W tym meczu nie prowadzisz drużyny.";
		if (minute >= FULL_TIME) return "Mecz jest zakończony.";
		const s = this.sideOf(side);
		if (change.kind === "tactic") {
			if (!(change.formation in FORMATIONS)) return "Nieznana formacja.";
			return null;
		}
		const onPitch = s.slots.some((x) => x.playerId === change.out);
		if (!onPitch && !s.vacancies.includes(change.out)) {
			return "Zawodnik schodzący nie jest na boisku.";
		}
		if (!s.bench.includes(change.in)) {
			return "Zmiennik nie jest na ławce albo już zszedł z boiska.";
		}
		if (this.subsLeft(s) === 0) {
			return `Wykorzystano limit ${this.model.maxSubs} zmian.`;
		}
		return null;
	}

	/** Applies a change of the user's side (AI-made subs for the user's injured player included). */
	apply(change: LiveChange, minute: number) {
		const side = this.setup.userSide;
		if (side === null || this.check(change, minute) !== null) return;
		const s = this.sideOf(side);
		if (change.kind === "tactic") {
			if (change.formation !== s.tactic.formation) {
				const onPitch = s.slots.flatMap((x) => {
					const p =
						x.playerId === null ? undefined : this.players.get(x.playerId);
					return p ? [p] : [];
				});
				s.slots = bestElevenFor(onPitch, change.formation).map((x) => ({
					role: x.role,
					playerId: x.player?.playerId ?? null,
				}));
			}
			s.tactic = { formation: change.formation, style: change.style };
			this.push({
				minute,
				side,
				kind: "tactic",
				playerId: null,
				formation: change.formation,
				style: change.style,
			});
			return;
		}
		let index = s.slots.findIndex((x) => x.playerId === change.out);
		if (index < 0) {
			// Replacing an injured player: the empty slot that suits the incoming player best.
			const incoming = this.players.get(change.in);
			let best = -1;
			for (const [i, slot] of s.slots.entries()) {
				if (slot.playerId !== null || !incoming) continue;
				const v = effectiveSlotOverall({ role: slot.role, player: incoming });
				const bestSlot = s.slots[best];
				if (
					best < 0 ||
					!bestSlot ||
					v > effectiveSlotOverall({ role: bestSlot.role, player: incoming })
				) {
					best = i;
				}
			}
			index = best;
		}
		if (index < 0) return;
		this.substitute(s, index, change.out, change.in, minute, change.by);
	}

	/** Replays minutes 1..upto; changes are applied at the end of their minute (0 = before kickoff). */
	run(changes: LiveChange[], upto: number) {
		const byMinute = (m: number) => changes.filter((c) => c.minute === m);
		for (const c of byMinute(0)) this.apply(c, 0);
		for (let m = 1; m <= upto; m++) {
			this.goalsAt(m);
			this.playerEventsAt(m);
			for (const c of byMinute(m)) this.apply(c, m);
			this.aiFatigueSubAt(this.home, m);
			this.aiFatigueSubAt(this.away, m);
			if (m === HALF_TIME) {
				this.push({ minute: m, side: null, kind: "half-time", playerId: null });
			}
			if (m === FULL_TIME) {
				this.push({ minute: m, side: null, kind: "full-time", playerId: null });
			}
		}
	}

	sideView(s: SideState, minute: number, lambda: number): LiveSideView {
		return {
			slots: s.slots.map((slot) => ({
				role: slot.role,
				playerId: slot.playerId,
				value:
					slot.playerId === null
						? 0
						: this.value(slot.playerId, Math.min(minute, FULL_TIME)),
			})),
			tactic: s.tactic,
			bench: [...s.bench],
			subsLeft: this.subsLeft(s),
			vacancies: [...s.vacancies],
			lambda,
		};
	}

	outcome(): LiveOutcome {
		const result = (side: Side) => {
			const own = this.score[side];
			const other = this.score[side === "home" ? "away" : "home"];
			return own > other ? "win" : own === other ? "draw" : "loss";
		};
		const players: LivePlayerOutcome[] = [];
		const played: number[] = [];
		for (const team of [this.setup.home, this.setup.away]) {
			const side: Side = team === this.setup.home ? "home" : "away";
			for (const p of [...team.eleven, ...team.bench]) {
				if (!p) continue;
				const log = this.logs.get(p.playerId);
				if (!log) continue;
				const minutes = (log.exit ?? FULL_TIME) - log.entry;
				if (minutes <= 0) continue;
				const before = this.setup.states[p.playerId] ?? freshState();
				const after = applyLiveOutcome(
					before,
					{ yellow: log.yellow, red: log.red, injured: log.injured, minutes },
					this.setup.round,
					this.model.state,
				);
				players.push({
					playerId: p.playerId,
					clubId: team.clubId,
					minutes,
					yellow: log.yellow,
					red: log.red,
					injured: log.injured,
					state: updateForm(after, result(side), this.model.state),
				});
				played.push(p.playerId);
			}
		}
		return { players, played };
	}
}

const sortedChanges = (changes: LiveChange[]): LiveChange[] =>
	changes
		.map((c, i) => ({ c, i }))
		.sort((a, b) => a.c.minute - b.c.minute || a.i - b.i)
		.map((x) => x.c);

function replay(
	setup: LiveSetup,
	seed: number,
	changes: LiveChange[],
	upto: number,
	model: LiveModel,
): Replay {
	const r = new Replay(setup, seed, model);
	const minute = Math.max(0, Math.min(FULL_TIME, Math.floor(upto)));
	r.run(
		sortedChanges(changes).filter((c) => c.minute <= minute),
		minute,
	);
	return r;
}

/**
 * The live match at the end of minute `uptoMinute` (0 = before kickoff, 90 = full time). Pure:
 * the same setup, seed and changes always give the same timeline, and a change at minute m
 * never alters events up to m (separate rng sub-streams per side and player).
 */
export function playLive(
	setup: LiveSetup,
	seed: number,
	changes: LiveChange[],
	uptoMinute: number,
	model: LiveModel = LIVE_MODEL,
): LiveResult {
	const r = replay(setup, seed, changes, uptoMinute, model);
	const minute = Math.max(0, Math.min(FULL_TIME, Math.floor(uptoMinute)));
	const lambda = r.lambdas(Math.min(FULL_TIME, minute + 1));
	const home = r.sideView(r.home, minute, lambda.home);
	const away = r.sideView(r.away, minute, lambda.away);
	const finished = minute >= FULL_TIME;
	return {
		minute,
		events: r.events,
		score: { ...r.score },
		onPitch: { home: home.slots, away: away.slots },
		subsLeft: { home: home.subsLeft, away: away.subsLeft },
		sides: { home, away },
		finished,
		...(finished ? { outcome: r.outcome() } : {}),
	};
}

/**
 * Validates a change of the user's side at the current server minute (= change.minute, 0..89,
 * not before the last change). Errors in Polish for the UI.
 */
export function validateChange(
	setup: LiveSetup,
	seed: number,
	changes: LiveChange[],
	change: LiveChange,
	model: LiveModel = LIVE_MODEL,
): { ok: true } | { ok: false; error: string } {
	if (
		!Number.isInteger(change.minute) ||
		change.minute < 0 ||
		change.minute >= FULL_TIME
	) {
		return { ok: false, error: "Mecz jest zakończony." };
	}
	const last = changes.reduce((m, c) => Math.max(m, c.minute), 0);
	if (change.minute < last) {
		return { ok: false, error: "Zmiana musi nastąpić w bieżącej minucie." };
	}
	const r = replay(setup, seed, changes, change.minute, model);
	const error = r.check(change, change.minute);
	return error === null ? { ok: true } : { ok: false, error };
}

/**
 * Adds explicit AI substitutions (by: "ai", dated at the injury minute) for injured players of
 * the user's side whose slot is still empty and whose injury minute is before `toMinute`; the
 * caller stores the returned list (plan-review F12). Returns `changes` unchanged when none apply.
 */
export function injuryAutoSubs(
	setup: LiveSetup,
	seed: number,
	changes: LiveChange[],
	toMinute: number,
	model: LiveModel = LIVE_MODEL,
): LiveChange[] {
	const side = setup.userSide;
	if (side === null) return changes;
	let current = sortedChanges(changes);
	const to = Math.min(FULL_TIME, toMinute);
	const skipped = new Set<number>();
	for (let guard = 0; guard < 2 * model.maxSubs + 2; guard++) {
		const r = replay(setup, seed, current, to, model);
		const injuries = r.events.filter(
			(e) =>
				e.kind === "injury" &&
				e.side === side &&
				e.minute < to &&
				e.playerId !== null &&
				!skipped.has(e.playerId),
		);
		let added = false;
		for (const injury of injuries) {
			const id = injury.playerId;
			if (id === null) continue;
			const at = replay(setup, seed, current, injury.minute, model);
			const s = side === "home" ? at.home : at.away;
			if (!s.vacancies.includes(id)) {
				skipped.add(id);
				continue;
			}
			const best =
				at.subsLeft(s) > 0 ? bestForVacancy(at, s, injury.minute) : null;
			if (!best) {
				skipped.add(id);
				continue;
			}
			const change: LiveChange = {
				minute: injury.minute,
				by: "ai",
				kind: "sub",
				out: id,
				in: best,
			};
			current = sortedChanges([...current, change]);
			added = true;
			break;
		}
		if (!added) break;
	}
	return current.length === changes.length ? changes : current;
}

function bestForVacancy(
	r: Replay,
	s: SideState,
	minute: number,
): number | null {
	let best: { id: number; value: number } | null = null;
	for (const slot of s.slots) {
		if (slot.playerId !== null) continue;
		const b = r.bestFor(s, slot.role, minute);
		if (b && (!best || b.value > best.value)) best = b;
	}
	return best?.id ?? null;
}

/** Score of a finished background-style match spread over minutes 1..90 (sorted), from `rng`. */
export function goalMinutes(
	homeGoals: number,
	awayGoals: number,
	rng: Rng,
): { minute: number; side: Side }[] {
	const out: { minute: number; side: Side }[] = [];
	for (let i = 0; i < homeGoals; i++) {
		out.push({ minute: minuteAfter(0, rng()), side: "home" });
	}
	for (let i = 0; i < awayGoals; i++) {
		out.push({ minute: minuteAfter(0, rng()), side: "away" });
	}
	return out.sort((a, b) => a.minute - b.minute);
}
