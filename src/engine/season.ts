// Season simulation round by round, league statistics and lineup-effect measurement.
// Pure module: no imports outside src/engine/ (runs from the CLI for calibration).

import type { PlayerAttributes } from "./attributes";
import { type FixtureResult, leagueTable } from "./club-strength";
import {
	MATCH_MODEL,
	type MatchModel,
	type Ratings,
	simulateMatchRatings,
} from "./match";
import {
	beforeRound,
	effectiveOverall,
	freshState,
	type MatchEvents,
	matchEvents,
	type PlayerState,
	STATE_MODEL,
	type StateModel,
	updateForm,
} from "./player-state";
import { createRng, type Rng } from "./rng";
import {
	bestElevenFor,
	DEFAULT_TACTIC,
	FORMATIONS,
	type Slot,
	type Tactic,
	teamRatings,
} from "./tactics";

export type SeasonFixture = {
	round: number;
	homeClubId: number;
	awayClubId: number;
};

/**
 * Picks the lineup for a round. Returns one entry per slot of the tactic's formation
 * (FORMATIONS[tactic.formation]), in slot order: length 11, the i-th entry takes the i-th slot,
 * null leaves that slot empty (no compaction, so later players keep their roles).
 */
export type LineupPicker = (
	squad: PlayerAttributes[],
	round: number,
	tactic: Tactic,
) => (PlayerAttributes | null)[];

/** Players of the best eleven for the formation, in slot order; null for an empty slot. */
export function bestElevenInSlotOrder(
	squad: PlayerAttributes[],
	tactic: Tactic = DEFAULT_TACTIC,
): (PlayerAttributes | null)[] {
	return bestElevenFor(squad, tactic.formation).map((s) => s.player);
}

const present = (lineup: (PlayerAttributes | null)[]): PlayerAttributes[] =>
	lineup.filter((p): p is PlayerAttributes => p !== null);

/** AI coach: always the best eleven for the club's formation. */
export const pickBestEleven = (
	squad: PlayerAttributes[],
	_round = 0,
	tactic: Tactic = DEFAULT_TACTIC,
): (PlayerAttributes | null)[] => bestElevenInSlotOrder(squad, tactic);

/** Rebuilds slots from a picker's lineup: the i-th entry fills the i-th formation role (null = empty). */
function slotsOf(lineup: (PlayerAttributes | null)[], tactic: Tactic): Slot[] {
	return FORMATIONS[tactic.formation].map((role, i) => ({
		role,
		player: lineup[i] ?? null,
	}));
}

export type SeasonOptions = {
	pickers?: Map<number, LineupPicker>;
	/** Tactic per club id; clubs without an entry play DEFAULT_TACTIC. */
	tactics?: Map<number, Tactic>;
	model?: MatchModel;
	stateModel?: StateModel;
	/** Player state between rounds (cards, injuries, fitness, form). Default true; false = S-10 behaviour. */
	consequences?: boolean;
};

export type SeasonStateStats = {
	yellows: number;
	reds: number;
	injuries: number;
	/** Mean number of injured squad players per (club, round played), judged at selection time. */
	injuredPerClubRound: number;
	/** Bans started per club per season. */
	suspensionsPerClub: number;
	/** Mean fitness (after recovery) of the picked lineups. */
	avgLineupFitness: number;
};

const EMPTY_STATE_STATS: SeasonStateStats = {
	yellows: 0,
	reds: 0,
	injuries: 0,
	injuredPerClubRound: 0,
	suspensionsPerClub: 0,
	avgLineupFitness: 0,
};

/** Plays fixtures by ascending round (input order within a round); lineups are picked per club per round. */
export function simulateSeason(
	fixtures: SeasonFixture[],
	squads: Map<number, PlayerAttributes[]>,
	rng: Rng,
	opts: SeasonOptions = {},
): FixtureResult[] {
	return simulateSeasonDetailed(fixtures, squads, rng, opts).results;
}

type Prepared = { ratings: Ratings; lineup: PlayerAttributes[] };

export type ClubRound = {
	ratings: Ratings;
	/** Picker output in slot order (null = empty slot). */
	picked: (PlayerAttributes | null)[];
	/** Picked players (effective copies), empty slots dropped. */
	lineup: PlayerAttributes[];
	/** Available squad players as copies with overall = effectiveOverall. */
	available: PlayerAttributes[];
	/** Squad players injured at selection time (before the countdown). */
	injured: number;
};

/**
 * Start of a round for a club that plays it: `beforeRound` for every squad player (written to
 * `states`; missing = freshState), then the picker sees the available players as copies with
 * overall adjusted for fitness and form. Uses no rng. Shared by the batch season and live rounds.
 */
export function prepareClubRound(
	squad: PlayerAttributes[],
	states: Map<number, PlayerState>,
	round: number,
	tactic: Tactic,
	picker: LineupPicker = pickBestEleven,
	stateModel: StateModel = STATE_MODEL,
): ClubRound {
	const available: PlayerAttributes[] = [];
	let injured = 0;
	for (const p of squad) {
		const before = states.get(p.playerId) ?? freshState();
		if (before.injuredFor > 0) injured++;
		const { state, available: ok } = beforeRound(before, true, stateModel);
		states.set(p.playerId, state);
		if (ok) {
			available.push({
				...p,
				overall: effectiveOverall(p, state, stateModel),
			});
		}
	}
	const picked = picker(available, round, tactic);
	return {
		ratings: teamRatings(slotsOf(picked, tactic), tactic),
		picked,
		lineup: present(picked),
		available,
		injured,
	};
}

/**
 * End of a batch match for one club: match events (6 rng() per lineup player found in
 * `originals`, in lineup order, drawn on the original attributes) and form from the result,
 * written to `states`. Returns the events in lineup order.
 */
export function afterClubMatch(
	lineup: PlayerAttributes[],
	originals: Map<number, PlayerAttributes>,
	states: Map<number, PlayerState>,
	round: number,
	goalsFor: number,
	goalsAgainst: number,
	rng: Rng,
	stateModel: StateModel = STATE_MODEL,
): MatchEvents[] {
	const result =
		goalsFor > goalsAgainst
			? "win"
			: goalsFor === goalsAgainst
				? "draw"
				: "loss";
	const events: MatchEvents[] = [];
	for (const p of lineup) {
		const original = originals.get(p.playerId);
		if (!original) continue;
		const before = states.get(p.playerId) ?? freshState();
		const ev = matchEvents(original, before, round, rng, stateModel);
		states.set(p.playerId, updateForm(ev.state, result, stateModel));
		events.push(ev);
	}
	return events;
}

/**
 * Like `simulateSeason`, plus state statistics. With consequences on, a club's players only get
 * their pre-round recovery / countdown in rounds the club plays; the picker sees available players
 * only, as copies with overall adjusted for fitness and form. After each match both lineups draw
 * match events (home first, then away, in picker order) and update form.
 */
export function simulateSeasonDetailed(
	fixtures: SeasonFixture[],
	squads: Map<number, PlayerAttributes[]>,
	rng: Rng,
	opts: SeasonOptions = {},
): { results: FixtureResult[]; state: SeasonStateStats } {
	const model = opts.model ?? MATCH_MODEL;
	const stateModel = opts.stateModel ?? STATE_MODEL;
	const consequences = opts.consequences ?? true;
	const ordered = fixtures
		.map((f, i) => ({ f, i }))
		.sort((a, b) => a.f.round - b.f.round || a.i - b.i)
		.map((x) => x.f);
	const playedInRound = new Map<number, Set<number>>();
	for (const f of ordered) {
		let seen = playedInRound.get(f.round);
		if (!seen) {
			seen = new Set();
			playedInRound.set(f.round, seen);
		}
		for (const id of [f.homeClubId, f.awayClubId]) {
			if (seen.has(id)) {
				throw new Error(
					`simulateSeason: club ${id} plays twice in round ${f.round}`,
				);
			}
			seen.add(id);
		}
	}
	const results: FixtureResult[] = [];
	const states = new Map<number, PlayerState>();
	const originals = new Map<number, PlayerAttributes>();
	const clubIds = new Set<number>();
	let yellows = 0;
	let reds = 0;
	let injuries = 0;
	let bans = 0;
	let injuredSum = 0;
	let clubRounds = 0;
	let fitnessSum = 0;
	let fitnessCount = 0;
	let cacheRound: number | undefined;
	let cache = new Map<number, Prepared>();
	const prepare = (clubId: number, round: number): Prepared => {
		if (cacheRound !== round) {
			cacheRound = round;
			cache = new Map();
		}
		const cached = cache.get(clubId);
		if (cached) return cached;
		const picker: LineupPicker = opts.pickers?.get(clubId) ?? pickBestEleven;
		const tactic = opts.tactics?.get(clubId) ?? DEFAULT_TACTIC;
		const squad = squads.get(clubId) ?? [];
		let prepared: Prepared;
		if (!consequences) {
			const picked = picker(squad, round, tactic);
			prepared = {
				ratings: teamRatings(slotsOf(picked, tactic), tactic),
				lineup: present(picked),
			};
		} else {
			for (const p of squad) originals.set(p.playerId, p);
			const club = prepareClubRound(
				squad,
				states,
				round,
				tactic,
				picker,
				stateModel,
			);
			injuredSum += club.injured;
			clubRounds++;
			for (const p of club.lineup) {
				fitnessSum += states.get(p.playerId)?.fitness ?? 100;
				fitnessCount++;
			}
			prepared = { ratings: club.ratings, lineup: club.lineup };
		}
		cache.set(clubId, prepared);
		return prepared;
	};
	const afterMatch = (
		clubId: number,
		round: number,
		goalsFor: number,
		goalsAgainst: number,
	) => {
		const events = afterClubMatch(
			cache.get(clubId)?.lineup ?? [],
			originals,
			states,
			round,
			goalsFor,
			goalsAgainst,
			rng,
			stateModel,
		);
		for (const ev of events) {
			if (ev.yellow) yellows++;
			if (ev.red !== "none") reds++;
			if (ev.injured > 0) injuries++;
			if (ev.banned > 0) bans++;
		}
	};
	for (const f of ordered) {
		clubIds.add(f.homeClubId);
		clubIds.add(f.awayClubId);
		const home = prepare(f.homeClubId, f.round);
		const away = prepare(f.awayClubId, f.round);
		const { homeGoals, awayGoals } = simulateMatchRatings(
			home.ratings,
			away.ratings,
			rng,
			model,
		);
		results.push({
			homeClubId: f.homeClubId,
			awayClubId: f.awayClubId,
			homeGoals,
			awayGoals,
		});
		if (consequences) {
			afterMatch(f.homeClubId, f.round, homeGoals, awayGoals);
			afterMatch(f.awayClubId, f.round, awayGoals, homeGoals);
		}
	}
	if (!consequences) return { results, state: { ...EMPTY_STATE_STATS } };
	return {
		results,
		state: {
			yellows,
			reds,
			injuries,
			injuredPerClubRound: clubRounds ? injuredSum / clubRounds : 0,
			suspensionsPerClub: clubIds.size ? bans / clubIds.size : 0,
			avgLineupFitness: fitnessCount ? fitnessSum / fitnessCount : 0,
		},
	};
}

export type LeagueStats = {
	matches: number;
	goalsPerMatch: number;
	homeWinPct: number;
	drawPct: number;
	awayWinPct: number;
	pointsStd: number;
	championPoints: number;
	lastPoints: number;
	yellowsPerMatch: number;
	redsPerMatch: number;
	injuredPerClub: number;
	suspensionsPerClub: number;
	avgLineupFitness: number;
};

const STAT_KEYS: (keyof LeagueStats)[] = [
	"matches",
	"goalsPerMatch",
	"homeWinPct",
	"drawPct",
	"awayWinPct",
	"pointsStd",
	"championPoints",
	"lastPoints",
	"yellowsPerMatch",
	"redsPerMatch",
	"injuredPerClub",
	"suspensionsPerClub",
	"avgLineupFitness",
];

export function leagueStats(
	results: FixtureResult[],
	clubs: { clubId: number; name: string }[],
	state?: SeasonStateStats,
): LeagueStats {
	const matches = results.length;
	if (matches === 0) {
		return {
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
		};
	}
	let goals = 0;
	let home = 0;
	let draw = 0;
	let away = 0;
	for (const r of results) {
		goals += r.homeGoals + r.awayGoals;
		if (r.homeGoals > r.awayGoals) home++;
		else if (r.homeGoals === r.awayGoals) draw++;
		else away++;
	}
	const table = leagueTable(results, clubs);
	const pts = table.map((t) => t.points);
	const mean = pts.length ? pts.reduce((s, x) => s + x, 0) / pts.length : 0;
	const variance = pts.length
		? pts.reduce((s, x) => s + (x - mean) ** 2, 0) / pts.length
		: 0;
	return {
		matches,
		goalsPerMatch: goals / matches,
		homeWinPct: (home / matches) * 100,
		drawPct: (draw / matches) * 100,
		awayWinPct: (away / matches) * 100,
		pointsStd: Math.sqrt(variance),
		championPoints: table[0]?.points ?? 0,
		lastPoints: table[table.length - 1]?.points ?? 0,
		yellowsPerMatch: state ? state.yellows / matches : 0,
		redsPerMatch: state ? state.reds / matches : 0,
		injuredPerClub: state?.injuredPerClubRound ?? 0,
		suspensionsPerClub: state?.suspensionsPerClub ?? 0,
		avgLineupFitness: state?.avgLineupFitness ?? 0,
	};
}

export type SeasonInput = {
	fixtures: SeasonFixture[];
	squads: Map<number, PlayerAttributes[]>;
	clubs: { clubId: number; name: string }[];
};

export type SeasonsResult = {
	stats: LeagueStats;
	perSeason: LeagueStats[];
	positions: Map<number, number[]>;
	points: Map<number, number[]>;
	/** Goals scored / conceded per club per season. */
	goalsFor: Map<number, number[]>;
	goalsAgainst: Map<number, number[]>;
};

/** Simulates n seasons from one rng seeded with `seed`; `stats` is the mean over seasons. */
export function simulateSeasons(
	input: SeasonInput,
	n: number,
	seed: number,
	opts: SeasonOptions = {},
): SeasonsResult {
	const rng = createRng(seed);
	const perSeason: LeagueStats[] = [];
	const positions = new Map<number, number[]>();
	const points = new Map<number, number[]>();
	const goalsFor = new Map<number, number[]>();
	const goalsAgainst = new Map<number, number[]>();
	for (const c of input.clubs) {
		positions.set(c.clubId, []);
		points.set(c.clubId, []);
		goalsFor.set(c.clubId, []);
		goalsAgainst.set(c.clubId, []);
	}
	for (let i = 0; i < n; i++) {
		const { results, state } = simulateSeasonDetailed(
			input.fixtures,
			input.squads,
			rng,
			opts,
		);
		perSeason.push(leagueStats(results, input.clubs, state));
		for (const row of leagueTable(results, input.clubs)) {
			positions.get(row.clubId)?.push(row.position);
			points.get(row.clubId)?.push(row.points);
		}
		const gf = new Map<number, number>();
		const ga = new Map<number, number>();
		for (const r of results) {
			gf.set(r.homeClubId, (gf.get(r.homeClubId) ?? 0) + r.homeGoals);
			ga.set(r.homeClubId, (ga.get(r.homeClubId) ?? 0) + r.awayGoals);
			gf.set(r.awayClubId, (gf.get(r.awayClubId) ?? 0) + r.awayGoals);
			ga.set(r.awayClubId, (ga.get(r.awayClubId) ?? 0) + r.homeGoals);
		}
		for (const c of input.clubs) {
			goalsFor.get(c.clubId)?.push(gf.get(c.clubId) ?? 0);
			goalsAgainst.get(c.clubId)?.push(ga.get(c.clubId) ?? 0);
		}
	}
	const stats = Object.fromEntries(
		STAT_KEYS.map((k) => [
			k,
			n > 0 ? perSeason.reduce((s, x) => s + x[k], 0) / n : 0,
		]),
	) as LeagueStats;
	return { stats, perSeason, positions, points, goalsFor, goalsAgainst };
}

/** Best eleven for the tactic's formation made only of players outside the best eleven (an evidently bad lineup). */
export function reserveEleven(
	squad: PlayerAttributes[],
	_round = 0,
	tactic: Tactic = DEFAULT_TACTIC,
): (PlayerAttributes | null)[] {
	const ids = new Set(
		present(bestElevenInSlotOrder(squad, tactic)).map((p) => p.playerId),
	);
	return bestElevenInSlotOrder(
		squad.filter((p) => !ids.has(p.playerId)),
		tactic,
	);
}

/** Best eleven after removing the `drop` highest-overall members of the best eleven. */
export function weakenedEleven(
	squad: PlayerAttributes[],
	_round = 0,
	tactic: Tactic = DEFAULT_TACTIC,
	drop = 3,
): (PlayerAttributes | null)[] {
	const top = present(bestElevenInSlotOrder(squad, tactic))
		.sort((a, b) => b.overall - a.overall || a.playerId - b.playerId)
		.slice(0, drop);
	const ids = new Set(top.map((p) => p.playerId));
	return bestElevenInSlotOrder(
		squad.filter((p) => !ids.has(p.playerId)),
		tactic,
	);
}

const mean = (xs: number[]) =>
	xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;

const sampleVariance = (xs: number[]) => {
	if (xs.length < 2) return 0;
	const m = mean(xs);
	return xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
};

/** Club points with `picker` versus the default best eleven, same seed; unpaired samples. */
export function lineupEffect(
	input: SeasonInput,
	clubId: number,
	picker: LineupPicker,
	n: number,
	seed: number,
	opts: SeasonOptions = {},
): { bestPoints: number; variantPoints: number; diff: number; se: number } {
	const basePickers = new Map(opts.pickers);
	basePickers.delete(clubId);
	const variantPickers = new Map(opts.pickers);
	variantPickers.set(clubId, picker);
	const best =
		simulateSeasons(input, n, seed, {
			...opts,
			pickers: basePickers,
		}).points.get(clubId) ?? [];
	const variant =
		simulateSeasons(input, n, seed, {
			...opts,
			pickers: variantPickers,
		}).points.get(clubId) ?? [];
	const bestPoints = mean(best);
	const variantPoints = mean(variant);
	const se =
		n < 2
			? 0
			: Math.sqrt(sampleVariance(best) / n + sampleVariance(variant) / n);
	return { bestPoints, variantPoints, diff: bestPoints - variantPoints, se };
}
