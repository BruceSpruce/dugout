// Player state between matches: cards and suspensions (Premier League rules), injuries, fitness and form.
// Pure module: no imports outside src/engine/ (runs from the CLI for calibration).

import type { PlayerAttributes } from "./attributes";
import type { Rng } from "./rng";

export type PlayerState = {
	/** 0-100, 100 = fully fresh. */
	fitness: number;
	/** -1..1, exponential moving average of recent results. */
	form: number;
	/** Yellow cards counted toward yellow-card bans (a second-yellow dismissal does not count). */
	yellowCount: number;
	/** Club matches still to miss because of a ban. */
	suspendedFor: number;
	/** Club matches still to miss because of an injury. */
	injuredFor: number;
};

export const freshState = (): PlayerState => ({
	fitness: 100,
	form: 0,
	yellowCount: 0,
	suspendedFor: 0,
	injuredFor: 0,
});

export type StateModel = {
	/** Yellow cards per player per match at discipline 50. */
	yellowBase: number;
	/** Straight red cards per player per match at discipline 50. */
	redBase: number;
	/** Chance that a yellow in a match is a second yellow (dismissal). */
	secondYellowShare: number;
	/** Card probability scales by exp(slope * (50 - discipline) / 50). */
	disciplineSlope: number;
	/** Injury chance per player per match. */
	injuryRate: number;
	/** Injury length buckets (inclusive match ranges, drawn uniformly within the bucket). */
	injuryDurations: { matches: [number, number]; weight: number }[];
	/** Fitness lost by playing a match. */
	fitnessCost: number;
	/** Fitness regained before each round. */
	fitnessRecovery: number;
	/** Max strength penalty at zero fitness. */
	fitnessWeight: number;
	/** Weight of the old form in the moving average. */
	formMemory: number;
	/** Strength change at form = +1 / -1. */
	formWeight: number;
};

/**
 * Calibrated 2026-11-13 on PL 2024 (100 seasons, seed 1): yellows 4.24/match (real 4.21), reds 0.140 (real 0.139),
 * injured per club 2.50, bans per club 7.0, lineup fitness 74.2; match gates unchanged (goals 2.73, home 44.2%, draws 23.8%, std 17.6).
 * secondYellowShare is per yellow card (real: 0.037 second-yellow reds per match / 4.2 yellows).
 */
export const STATE_MODEL: StateModel = {
	yellowBase: 0.1671,
	redBase: 0.00416,
	secondYellowShare: 0.0088,
	disciplineSlope: 1,
	injuryRate: 0.065,
	injuryDurations: [
		{ matches: [1, 1], weight: 0.45 },
		{ matches: [2, 4], weight: 0.3 },
		{ matches: [5, 10], weight: 0.17 },
		{ matches: [11, 25], weight: 0.08 },
	],
	fitnessCost: 12,
	fitnessRecovery: 9,
	fitnessWeight: 0.1,
	formMemory: 0.7,
	formWeight: 0.03,
};

export type RedCard = "none" | "straight" | "second-yellow";

export type MatchEvents = {
	state: PlayerState;
	yellow: boolean;
	red: RedCard;
	/** Injury length in matches, 0 = no injury. */
	injured: number;
	/** Matches of ban added by this match. */
	banned: number;
};

const MAX_CARD_PROBABILITY = 0.95;

export const isAvailable = (s: PlayerState): boolean =>
	s.suspendedFor === 0 && s.injuredFor === 0;

function cardProbability(
	base: number,
	discipline: number,
	model: StateModel,
): number {
	const p = base * Math.exp((model.disciplineSlope * (50 - discipline)) / 50);
	return Math.min(MAX_CARD_PROBABILITY, Math.max(0, p));
}

function drawInjuryDuration(rng: Rng, model: StateModel): number {
	const total = model.injuryDurations.reduce((s, d) => s + d.weight, 0);
	const pick = rng() * total;
	const u = rng();
	let acc = 0;
	let chosen = model.injuryDurations[model.injuryDurations.length - 1];
	for (const bucket of model.injuryDurations) {
		acc += bucket.weight;
		if (pick < acc) {
			chosen = bucket;
			break;
		}
	}
	if (!chosen) return 0;
	const [min, max] = chosen.matches;
	return min + Math.floor(u * (max - min + 1));
}

/** Bans from reaching a yellow-card threshold (PL: 5 by round 19, 10 by round 32, 15 any time). */
function yellowBan(count: number, round: number): number {
	if (count === 5 && round <= 19) return 1;
	if (count === 10 && round <= 32) return 2;
	if (count === 15) return 3;
	return 0;
}

/**
 * Events of one match for a player of the starting eleven. Always consumes exactly 6 rng()
 * calls (yellow, second yellow, straight red, injury, 2 for the injury duration) whatever the
 * outcome, so rng streams stay aligned between variants of the same season.
 */
export function matchEvents(
	player: PlayerAttributes,
	state: PlayerState,
	round: number,
	rng: Rng,
	model: StateModel = STATE_MODEL,
): MatchEvents {
	const pYellow = cardProbability(model.yellowBase, player.discipline, model);
	const pRed = cardProbability(model.redBase, player.discipline, model);
	const uYellow = rng();
	const uSecond = rng();
	const uRed = rng();
	const uInjury = rng();
	const duration = drawInjuryDuration(rng, model);

	const yellow = uYellow < pYellow;
	let red: RedCard = "none";
	if (yellow && uSecond < model.secondYellowShare) red = "second-yellow";
	else if (uRed < pRed) red = "straight";

	let banned = 0;
	let yellowCount = state.yellowCount;
	if (red === "second-yellow") banned = 1;
	else if (red === "straight") banned = 3;
	if (yellow && red !== "second-yellow") {
		yellowCount += 1;
		banned += yellowBan(yellowCount, round);
	}

	const injured = uInjury < model.injuryRate ? duration : 0;

	return {
		state: {
			fitness: Math.max(0, state.fitness - model.fitnessCost),
			form: state.form,
			yellowCount,
			suspendedFor: state.suspendedFor + banned,
			injuredFor: Math.max(state.injuredFor, injured),
		},
		yellow,
		red,
		injured,
		banned,
	};
}

export function updateForm(
	state: PlayerState,
	result: "win" | "draw" | "loss",
	model: StateModel = STATE_MODEL,
): PlayerState {
	const target = result === "win" ? 1 : result === "loss" ? -1 : 0;
	return {
		...state,
		form: model.formMemory * state.form + (1 - model.formMemory) * target,
	};
}

/**
 * Start of a round for a player. `available` is judged on the incoming state (a ban of N means
 * the player misses the club's next N matches); counters then drop by 1 when the club plays.
 */
export function beforeRound(
	state: PlayerState,
	played: boolean,
	model: StateModel = STATE_MODEL,
): { state: PlayerState; available: boolean } {
	const available = isAvailable(state);
	return {
		available,
		state: {
			...state,
			fitness: Math.min(100, state.fitness + model.fitnessRecovery),
			suspendedFor: played
				? Math.max(0, state.suspendedFor - 1)
				: state.suspendedFor,
			injuredFor: played ? Math.max(0, state.injuredFor - 1) : state.injuredFor,
		},
	};
}

export function effectiveOverall(
	player: PlayerAttributes,
	state: PlayerState,
	model: StateModel = STATE_MODEL,
): number {
	return (
		player.overall *
		(1 - (model.fitnessWeight * (100 - state.fitness)) / 100) *
		(1 + model.formWeight * state.form)
	);
}
