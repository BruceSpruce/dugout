// Season simulation round by round, league statistics and lineup-effect measurement.
// Pure module: no imports outside src/engine/ (runs from the CLI for calibration).

import type { PlayerAttributes } from "./attributes";
import {
	bestEleven,
	type FixtureResult,
	leagueTable,
	lineupStrength,
} from "./club-strength";
import { MATCH_MODEL, type MatchModel, simulateMatch } from "./match";
import { createRng, type Rng } from "./rng";

export type SeasonFixture = {
	round: number;
	homeClubId: number;
	awayClubId: number;
};

export type LineupPicker = (
	squad: PlayerAttributes[],
	round: number,
) => PlayerAttributes[];

/** AI coach v1: always the best eleven. */
export const pickBestEleven: LineupPicker = (squad) => bestEleven(squad);

export type SeasonOptions = {
	pickers?: Map<number, LineupPicker>;
	model?: MatchModel;
};

/** Plays fixtures by ascending round (input order within a round); lineups are picked per club per round. */
export function simulateSeason(
	fixtures: SeasonFixture[],
	squads: Map<number, PlayerAttributes[]>,
	rng: Rng,
	opts: SeasonOptions = {},
): FixtureResult[] {
	const model = opts.model ?? MATCH_MODEL;
	const ordered = fixtures
		.map((f, i) => ({ f, i }))
		.sort((a, b) => a.f.round - b.f.round || a.i - b.i)
		.map((x) => x.f);
	const results: FixtureResult[] = [];
	let cacheRound: number | undefined;
	let cache = new Map<number, number>();
	const strengthOf = (clubId: number, round: number): number => {
		if (cacheRound !== round) {
			cacheRound = round;
			cache = new Map();
		}
		const cached = cache.get(clubId);
		if (cached !== undefined) return cached;
		const picker = opts.pickers?.get(clubId) ?? pickBestEleven;
		const value = lineupStrength(picker(squads.get(clubId) ?? [], round));
		cache.set(clubId, value);
		return value;
	};
	for (const f of ordered) {
		const { homeGoals, awayGoals } = simulateMatch(
			strengthOf(f.homeClubId, f.round),
			strengthOf(f.awayClubId, f.round),
			rng,
			model,
		);
		results.push({
			homeClubId: f.homeClubId,
			awayClubId: f.awayClubId,
			homeGoals,
			awayGoals,
		});
	}
	return results;
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
];

export function leagueStats(
	results: FixtureResult[],
	clubs: { clubId: number; name: string }[],
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
	for (const c of input.clubs) {
		positions.set(c.clubId, []);
		points.set(c.clubId, []);
	}
	for (let i = 0; i < n; i++) {
		const results = simulateSeason(input.fixtures, input.squads, rng, opts);
		perSeason.push(leagueStats(results, input.clubs));
		for (const row of leagueTable(results, input.clubs)) {
			positions.get(row.clubId)?.push(row.position);
			points.get(row.clubId)?.push(row.points);
		}
	}
	const stats = Object.fromEntries(
		STAT_KEYS.map((k) => [
			k,
			n > 0 ? perSeason.reduce((s, x) => s + x[k], 0) / n : 0,
		]),
	) as LeagueStats;
	return { stats, perSeason, positions, points };
}

/** Best eleven made only of players outside the best eleven (an evidently bad lineup). */
export function reserveEleven(squad: PlayerAttributes[]): PlayerAttributes[] {
	const ids = new Set(bestEleven(squad).map((p) => p.playerId));
	return bestEleven(squad.filter((p) => !ids.has(p.playerId)));
}

/** Best eleven after removing the `drop` highest-overall members of the best eleven. */
export function weakenedEleven(
	squad: PlayerAttributes[],
	drop = 3,
): PlayerAttributes[] {
	const top = [...bestEleven(squad)]
		.sort((a, b) => b.overall - a.overall || a.playerId - b.playerId)
		.slice(0, drop);
	const ids = new Set(top.map((p) => p.playerId));
	return bestEleven(squad.filter((p) => !ids.has(p.playerId)));
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
