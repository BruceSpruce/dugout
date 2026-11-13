// Calibration report: simulated seasons vs. the real league and PRD ranges, on one screen.
// Pure module: no imports outside src/engine/ (runs from the CLI for calibration).

import type { PlayerAttributes, PlayerInput } from "./attributes";
import { computeAttributes } from "./attributes";
import {
	clubStrength,
	type FixtureResult,
	leagueTable,
	spearman,
} from "./club-strength";
import type { MatchModel } from "./match";
import type { StateModel } from "./player-state";
import {
	type LeagueStats,
	leagueStats,
	lineupEffect,
	reserveEleven,
	type SeasonFixture,
	type SeasonInput,
	simulateSeasons,
	weakenedEleven,
} from "./season";
import { DEFAULT_TACTIC, type Tactic } from "./tactics";

/** PRD ranges (inclusive). */
export const GOALS_RANGE: readonly [number, number] = [2.5, 2.9];
export const HOME_WIN_PCT_RANGE: readonly [number, number] = [40, 48];
export const DRAW_PCT_RANGE: readonly [number, number] = [22, 28];
export const POINTS_STD_RANGE: readonly [number, number] = [15, 21];
export const YELLOWS_PER_MATCH_RANGE: readonly [number, number] = [3.6, 4.8];

export type CalibrationReportInput = {
	/** Label printed in the header, e.g. "39/2024". */
	season: string;
	players: PlayerInput[];
	clubs: { clubId: number; name: string; apiId: number }[];
	results: FixtureResult[];
	fixtures: SeasonFixture[];
};

export type CalibrationReportOptions = {
	seasons?: number;
	seed?: number;
	club?: string;
	now?: () => number;
	model?: MatchModel;
	stateModel?: StateModel;
};

export type CalibrationReport = { lines: string[]; exitCode: 0 | 1 | 3 };

const TOP_ROWS = 6;
const DEFAULT_CLUB_RANK = 10;

const inRange = (v: number, [lo, hi]: readonly [number, number]) =>
	v >= lo && v <= hi;
const verdict = (ok: boolean) => (ok ? "PASS" : "FAIL");
const f = (v: number, d = 2) => v.toFixed(d);

function findClub(input: CalibrationReportInput, query: string) {
	const q = query.trim().toLowerCase();
	return input.clubs.find(
		(c) => c.name.toLowerCase() === q || String(c.apiId) === q,
	);
}

export function buildCalibrationReport(
	input: CalibrationReportInput,
	opts: CalibrationReportOptions = {},
): CalibrationReport {
	const seasons = opts.seasons ?? 100;
	const seed = opts.seed ?? 1;
	const now = opts.now ?? (() => performance.now());
	const modelOpts = {
		...(opts.model ? { model: opts.model } : {}),
		...(opts.stateModel ? { stateModel: opts.stateModel } : {}),
	};

	let lineupClub =
		opts.club !== undefined ? findClub(input, opts.club) : undefined;
	if (opts.club !== undefined && !lineupClub) {
		return { lines: [`Unknown club: ${opts.club}`], exitCode: 1 };
	}

	const squads = new Map<number, PlayerAttributes[]>();
	for (const c of input.clubs) squads.set(c.clubId, []);
	for (const a of computeAttributes(input.players)) {
		const list = squads.get(a.clubId);
		if (list) list.push(a);
		else squads.set(a.clubId, [a]);
	}

	const ranking = input.clubs
		.map((c) => ({
			...c,
			strength: clubStrength(squads.get(c.clubId) ?? []),
		}))
		.sort((a, b) => b.strength - a.strength || a.name.localeCompare(b.name));
	if (!lineupClub) {
		lineupClub = ranking[Math.min(DEFAULT_CLUB_RANK, ranking.length) - 1];
	}

	const real = leagueStats(input.results, input.clubs);
	// Real cards come from player counters (substitutes included), per match with a result.
	if (input.results.length > 0) {
		let yellows = 0;
		let reds = 0;
		for (const p of input.players) {
			yellows += p.counters.yellowCards;
			reds += p.counters.redCards + p.counters.yellowRedCards;
		}
		real.yellowsPerMatch = yellows / input.results.length;
		real.redsPerMatch = reds / input.results.length;
	}
	const realTable = leagueTable(input.results, input.clubs);
	const seasonInput: SeasonInput = {
		fixtures: input.fixtures,
		squads,
		clubs: input.clubs,
	};

	const t0 = now();
	const sim = simulateSeasons(seasonInput, seasons, seed, modelOpts);
	const elapsed = now() - t0;

	const failed: string[] = [];
	const gate = (name: string, ok: boolean) => {
		if (!ok) failed.push(name);
		return verdict(ok);
	};
	const s: LeagueStats = sim.stats;
	const row = (
		label: string,
		simV: number,
		realV: number,
		range: string,
		pf: string,
		d = 2,
	) =>
		`${label.padEnd(18)} ${f(simV, d).padStart(7)} ${(Number.isNaN(realV) ? "—" : f(realV, d)).padStart(7)} ${range.padStart(9)} ${pf}`;

	const lines = [
		`kalibracja ${input.season}: sezonów ${seasons}, seed ${seed}, ${Math.round(elapsed)} ms (${f(seasons > 0 ? elapsed / seasons : 0, 1)} ms/sezon), kluby ${input.clubs.length}`,
		`${"metryka".padEnd(18)} ${"sim".padStart(7)} ${"real".padStart(7)} ${"PRD".padStart(9)} wynik`,
		row(
			"gole/mecz",
			s.goalsPerMatch,
			real.goalsPerMatch,
			`${GOALS_RANGE[0]}–${GOALS_RANGE[1]}`,
			gate("goalsPerMatch", inRange(s.goalsPerMatch, GOALS_RANGE)),
		),
		row(
			"wygrane gosp. %",
			s.homeWinPct,
			real.homeWinPct,
			`${HOME_WIN_PCT_RANGE[0]}–${HOME_WIN_PCT_RANGE[1]}`,
			gate("homeWinPct", inRange(s.homeWinPct, HOME_WIN_PCT_RANGE)),
			1,
		),
		row(
			"remisy %",
			s.drawPct,
			real.drawPct,
			`${DRAW_PCT_RANGE[0]}–${DRAW_PCT_RANGE[1]}`,
			gate("drawPct", inRange(s.drawPct, DRAW_PCT_RANGE)),
			1,
		),
		row("wygrane gości %", s.awayWinPct, real.awayWinPct, "", "info", 1),
		row(
			"odch. std pkt",
			s.pointsStd,
			real.pointsStd,
			`${POINTS_STD_RANGE[0]}–${POINTS_STD_RANGE[1]}`,
			gate("pointsStd", inRange(s.pointsStd, POINTS_STD_RANGE)),
			1,
		),
		row(
			"żółte/mecz",
			s.yellowsPerMatch,
			real.yellowsPerMatch,
			`${YELLOWS_PER_MATCH_RANGE[0]}–${YELLOWS_PER_MATCH_RANGE[1]}`,
			gate(
				"yellowsPerMatch",
				inRange(s.yellowsPerMatch, YELLOWS_PER_MATCH_RANGE),
			),
		),
		row("czerwone/mecz", s.redsPerMatch, real.redsPerMatch, "", "info", 3),
		row("kontuzjowani/klub", s.injuredPerClub, Number.NaN, "", "info", 2),
		row("pauzy/klub/sezon", s.suspensionsPerClub, Number.NaN, "", "info", 2),
		row("kondycja 11", s.avgLineupFitness, Number.NaN, "", "info", 1),
		row("mistrz pkt", s.championPoints, real.championPoints, "", "info", 1),
		row("ostatni pkt", s.lastPoints, real.lastPoints, "", "info", 1),
		`top ${TOP_ROWS} wg siły: ${"klub".padEnd(20)} siła  śr.msc  mistrz%  top4%  real`,
	];

	const mean = (xs: number[]) =>
		xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
	const pct = (xs: number[], pred: (p: number) => boolean) =>
		xs.length ? (xs.filter(pred).length / xs.length) * 100 : 0;
	const realPos = new Map(realTable.map((t) => [t.clubId, t.position]));
	for (const [i, c] of ranking.slice(0, TOP_ROWS).entries()) {
		const pos = sim.positions.get(c.clubId) ?? [];
		lines.push(
			`${String(i + 1).padStart(2)}. ${c.name.slice(0, 22).padEnd(22)} ${f(c.strength, 1).padStart(6)} ${f(mean(pos), 1).padStart(6)} ${f(
				pct(pos, (p) => p === 1),
				0,
			).padStart(8)} ${f(
				pct(pos, (p) => p <= 4),
				0,
			).padStart(6)} ${String(realPos.get(c.clubId) ?? "-").padStart(5)}`,
		);
	}
	const rho = spearman(
		ranking.map((c) => -c.strength),
		ranking.map((c) => mean(sim.positions.get(c.clubId) ?? [])),
	);
	lines.push(`Spearman(siła, śr. miejsce sim) = ${f(rho)} (info)`);

	if (lineupClub) {
		const club = lineupClub;
		const variants: [string, "lineup-weakened" | "lineup-reserve"][] = [
			["osłabiona 11 (bez 3 najlepszych)", "lineup-weakened"],
			["rezerwowa 11", "lineup-reserve"],
		];
		lines.push(`test składu: ${club.name}, najlepsza 11 kontra`);
		for (const [label, name] of variants) {
			const picker =
				name === "lineup-weakened"
					? (sq: PlayerAttributes[], round: number, tactic: Tactic) =>
							weakenedEleven(sq, round, tactic)
					: (sq: PlayerAttributes[], round: number, tactic: Tactic) =>
							reserveEleven(sq, round, tactic);
			const e = lineupEffect(
				seasonInput,
				club.clubId,
				picker,
				seasons,
				seed,
				modelOpts,
			);
			lines.push(
				`  ${label.padEnd(33)} pkt ${f(e.bestPoints, 1)} vs ${f(e.variantPoints, 1)}, różnica ${f(e.diff, 1)}, 2·SE ${f(2 * e.se, 1)} ${gate(name, e.diff > 2 * e.se)}`,
			);
		}
	}

	if (lineupClub) {
		const clubId = lineupClub.clubId;
		const matchesPerSeason = input.fixtures.filter(
			(x) => x.homeClubId === clubId || x.awayClubId === clubId,
		).length;
		const goalsOf = (tactic: Tactic) => {
			const r = simulateSeasons(seasonInput, seasons, seed, {
				...modelOpts,
				tactics: new Map([[clubId, tactic]]),
			});
			const per = (m: Map<number, number[]>) =>
				matchesPerSeason > 0 ? mean(m.get(clubId) ?? []) / matchesPerSeason : 0;
			return `${f(per(r.goalsFor))}/${f(per(r.goalsAgainst))}`;
		};
		const compare = (label: string, a: [string, Tactic], b: [string, Tactic]) =>
			`  ${label.padEnd(28)} gole ${goalsOf(a[1])} vs ${goalsOf(b[1])} na mecz (${a[0]} vs ${b[0]}, strzelone/stracone)`;
		lines.push(
			compare(
				"styl ofensywny vs defensywny",
				["ofens.", { ...DEFAULT_TACTIC, style: "attacking" }],
				["defens.", { ...DEFAULT_TACTIC, style: "defensive" }],
			),
			compare(
				"formacja 4-3-3 vs 5-3-2",
				["4-3-3", { ...DEFAULT_TACTIC, formation: "4-3-3" }],
				["5-3-2", { ...DEFAULT_TACTIC, formation: "5-3-2" }],
			),
		);
	}

	lines.push(failed.length === 0 ? "→ PASS" : `→ FAIL (${failed.join(", ")})`);
	return { lines, exitCode: failed.length === 0 ? 0 : 3 };
}
