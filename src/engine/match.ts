// Single-match result model: independent Poisson goals driven by the strength gap and home advantage.
// Pure module: no imports outside src/engine/ (runs from the CLI for calibration).

import { poisson, type Rng } from "./rng";

export type MatchModel = {
	logBaseGoals: number;
	homeAdvantage: number;
	strengthBeta: number;
};

/** Starting values (middle of the admissible region measured on PL 2024); tuned in phase 3. */
export const MATCH_MODEL: MatchModel = {
	logBaseGoals: 0.17,
	homeAdvantage: 0.22,
	strengthBeta: 0.02,
};

export function expectedGoals(
	homeStrength: number,
	awayStrength: number,
	model: MatchModel = MATCH_MODEL,
): { home: number; away: number } {
	const delta = homeStrength - awayStrength;
	return {
		home: Math.exp(
			model.logBaseGoals + model.homeAdvantage + model.strengthBeta * delta,
		),
		away: Math.exp(model.logBaseGoals - model.strengthBeta * delta),
	};
}

/** Draws home goals first, then away goals. */
export function simulateMatch(
	homeStrength: number,
	awayStrength: number,
	rng: Rng,
	model: MatchModel = MATCH_MODEL,
): { homeGoals: number; awayGoals: number } {
	const lambda = expectedGoals(homeStrength, awayStrength, model);
	const homeGoals = poisson(rng, lambda.home);
	const awayGoals = poisson(rng, lambda.away);
	return { homeGoals, awayGoals };
}
