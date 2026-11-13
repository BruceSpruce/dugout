// Single-match result model: a joint score distribution (Poisson goals with a Dixon-Coles
// low-score correction) driven by the strength gap and home advantage.
// Pure module: no imports outside src/engine/ (runs from the CLI for calibration).

import type { Rng } from "./rng";

export type MatchModel = {
	logBaseGoals: number;
	homeAdvantage: number;
	strengthBeta: number;
	/** Dixon-Coles rho for low scores; 0 means independent Poisson goals. */
	drawRho: number;
};

/** Scores 0..MAX_GOALS are modelled per side; the probability mass beyond is negligible. */
export const MAX_GOALS = 10;

/**
 * Calibrated 2026-11-13 on PL 2024 (100 seasons, seed 1) after the attack/defense ratings (S-06): goals 2.68,
 * home wins 43.2%, draws 24.7%, points std 18.3. logBaseGoals 0.07 -> -0.08: role-weighted attack exceeds
 * defense by ~2.8 points on average, which alone lifted goals to 3.11.
 */
export const MATCH_MODEL: MatchModel = {
	logBaseGoals: -0.08,
	homeAdvantage: 0.25,
	strengthBeta: 0.055,
	drawRho: -0.1,
};

export type Ratings = { attack: number; defense: number };

/** Goals from one side's attack against the other's defense; attack = defense = strength is the strength-gap model. */
export function expectedGoalsRatings(
	home: Ratings,
	away: Ratings,
	model: MatchModel = MATCH_MODEL,
): { home: number; away: number } {
	return {
		home: Math.exp(
			model.logBaseGoals +
				model.homeAdvantage +
				model.strengthBeta * (home.attack - away.defense),
		),
		away: Math.exp(
			model.logBaseGoals + model.strengthBeta * (away.attack - home.defense),
		),
	};
}

export function expectedGoals(
	homeStrength: number,
	awayStrength: number,
	model: MatchModel = MATCH_MODEL,
): { home: number; away: number } {
	return expectedGoalsRatings(
		{ attack: homeStrength, defense: homeStrength },
		{ attack: awayStrength, defense: awayStrength },
		model,
	);
}

function poissonPmf(lambda: number): number[] {
	const pmf: number[] = [];
	let p = Math.exp(-lambda);
	for (let k = 0; k <= MAX_GOALS; k++) {
		pmf.push(p);
		p = (p * lambda) / (k + 1);
	}
	return pmf;
}

/** Dixon-Coles correction factor for low scores; 1 elsewhere. */
function tau(
	x: number,
	y: number,
	lambdaHome: number,
	lambdaAway: number,
	rho: number,
): number {
	if (x === 0 && y === 0) return 1 - lambdaHome * lambdaAway * rho;
	if (x === 0 && y === 1) return 1 + lambdaHome * rho;
	if (x === 1 && y === 0) return 1 + lambdaAway * rho;
	if (x === 1 && y === 1) return 1 - rho;
	return 1;
}

/** Score probabilities [home][away] for 0..MAX_GOALS; non-negative, sums to 1. */
export function scoreProbabilities(
	lambdaHome: number,
	lambdaAway: number,
	rho: number,
): number[][] {
	const homePmf = poissonPmf(lambdaHome);
	const awayPmf = poissonPmf(lambdaAway);
	let total = 0;
	const grid = homePmf.map((ph, x) =>
		awayPmf.map((pa, y) => {
			const cell =
				Math.max(0, tau(x, y, lambdaHome, lambdaAway, rho)) * ph * pa;
			total += cell;
			return cell;
		}),
	);
	return grid.map((row) => row.map((cell) => cell / total));
}

/** One rng() call: inverse-CDF draw over the score grid, row by row (home, then away). */
export function simulateMatchRatings(
	home: Ratings,
	away: Ratings,
	rng: Rng,
	model: MatchModel = MATCH_MODEL,
): { homeGoals: number; awayGoals: number } {
	const lambda = expectedGoalsRatings(home, away, model);
	const grid = scoreProbabilities(lambda.home, lambda.away, model.drawRho);
	let u = rng();
	let last = { homeGoals: 0, awayGoals: 0 };
	for (let x = 0; x < grid.length; x++) {
		const row = grid[x] ?? [];
		for (let y = 0; y < row.length; y++) {
			const p = row[y] ?? 0;
			if (p <= 0) continue;
			if (u < p) return { homeGoals: x, awayGoals: y };
			u -= p;
			last = { homeGoals: x, awayGoals: y };
		}
	}
	return last;
}

export function simulateMatch(
	homeStrength: number,
	awayStrength: number,
	rng: Rng,
	model: MatchModel = MATCH_MODEL,
): { homeGoals: number; awayGoals: number } {
	return simulateMatchRatings(
		{ attack: homeStrength, defense: homeStrength },
		{ attack: awayStrength, defense: awayStrength },
		rng,
		model,
	);
}
