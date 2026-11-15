// Live-match calibration: live matches with the AI coach on both sides on real squads, against the
// kickoff (batch) score and the PRD ranges.
// Pure module: no imports outside src/engine/ (runs from the CLI for calibration).

import type { PlayerAttributes, PlayerInput } from "./attributes";
import { computeAttributes } from "./attributes";
import {
	DRAW_PCT_RANGE,
	GOALS_RANGE,
	HOME_WIN_PCT_RANGE,
} from "./calibration-report";
import {
	aiLiveTeam,
	deriveSeed,
	LIVE_MODEL,
	type LiveModel,
	playLive,
} from "./live-match";
import { simulateMatchRatings } from "./match";
import { createRng } from "./rng";
import type { SeasonFixture } from "./season";
import { DEFAULT_TACTIC, FORMATIONS, teamRatings } from "./tactics";

export type LiveCalibrationInput = {
	/** Label printed in the header, e.g. "39/2024". */
	season: string;
	players: PlayerInput[];
	clubs: { clubId: number; name: string }[];
	fixtures: SeasonFixture[];
};

export type LiveStats = {
	matches: number;
	goalsPerMatch: number;
	homeWinPct: number;
	drawPct: number;
	awayWinPct: number;
	subsPerMatch: number;
	yellowsPerMatch: number;
	redsPerMatch: number;
	injuriesPerMatch: number;
	/** The same matches scored once at kickoff by simulateMatchRatings (the batch model). */
	kickoff: { goalsPerMatch: number; homeWinPct: number; drawPct: number };
};

/** Plays `matches` live matches cycling through the fixtures, every player at freshState. */
export function liveStats(
	squads: Map<number, PlayerAttributes[]>,
	fixtures: SeasonFixture[],
	matches: number,
	seed: number,
	model: LiveModel = LIVE_MODEL,
): LiveStats {
	const counts = {
		goals: 0,
		home: 0,
		draw: 0,
		away: 0,
		subs: 0,
		yellows: 0,
		reds: 0,
		injuries: 0,
	};
	const k = { goals: 0, home: 0, draw: 0 };
	const kickoffRng = createRng(deriveSeed(seed, 0xbeef));
	const teams = new Map(
		[...squads].map(([clubId, squad]) => [
			clubId,
			aiLiveTeam(clubId, squad, DEFAULT_TACTIC, model.benchSize),
		]),
	);
	const n = fixtures.length > 0 ? matches : 0;
	for (let i = 0; i < n; i++) {
		const f = fixtures[i % fixtures.length];
		const home = f && teams.get(f.homeClubId);
		const away = f && teams.get(f.awayClubId);
		if (!home || !away) continue;
		const r = playLive(
			{ round: 1, userSide: null, home, away, states: {} },
			deriveSeed(seed, i),
			[],
			90,
			model,
		);
		counts.goals += r.score.home + r.score.away;
		if (r.score.home > r.score.away) counts.home++;
		else if (r.score.home === r.score.away) counts.draw++;
		else counts.away++;
		for (const e of r.events) {
			if (e.kind === "sub") counts.subs++;
			if (e.kind === "yellow") counts.yellows++;
			if (e.kind === "red" || e.kind === "second-yellow") counts.reds++;
			if (e.kind === "injury") counts.injuries++;
		}
		const slots = (t: typeof home) =>
			FORMATIONS[t.tactic.formation].map((role, j) => ({
				role,
				player: t.eleven[j] ?? null,
			}));
		const ko = simulateMatchRatings(
			teamRatings(slots(home), home.tactic),
			teamRatings(slots(away), away.tactic),
			kickoffRng,
			model.match,
		);
		k.goals += ko.homeGoals + ko.awayGoals;
		if (ko.homeGoals > ko.awayGoals) k.home++;
		else if (ko.homeGoals === ko.awayGoals) k.draw++;
	}
	const per = (x: number) => (n > 0 ? x / n : 0);
	return {
		matches: n,
		goalsPerMatch: per(counts.goals),
		homeWinPct: per(counts.home) * 100,
		drawPct: per(counts.draw) * 100,
		awayWinPct: per(counts.away) * 100,
		subsPerMatch: per(counts.subs),
		yellowsPerMatch: per(counts.yellows),
		redsPerMatch: per(counts.reds),
		injuriesPerMatch: per(counts.injuries),
		kickoff: {
			goalsPerMatch: per(k.goals),
			homeWinPct: per(k.home) * 100,
			drawPct: per(k.draw) * 100,
		},
	};
}

export type LiveCalibrationReport = { lines: string[]; exitCode: 0 | 3 };

const inRange = (v: number, [lo, hi]: readonly [number, number]) =>
	v >= lo && v <= hi;
const f = (v: number, d = 2) => v.toFixed(d);

export function buildLiveCalibrationReport(
	input: LiveCalibrationInput,
	opts: {
		matches?: number;
		seed?: number;
		now?: () => number;
		model?: LiveModel;
	} = {},
): LiveCalibrationReport {
	const matches = opts.matches ?? 3800;
	const seed = opts.seed ?? 1;
	const now = opts.now ?? (() => performance.now());
	const model = opts.model ?? LIVE_MODEL;
	const squads = new Map<number, PlayerAttributes[]>();
	for (const c of input.clubs) squads.set(c.clubId, []);
	for (const a of computeAttributes(input.players)) {
		const list = squads.get(a.clubId);
		if (list) list.push(a);
		else squads.set(a.clubId, [a]);
	}
	const t0 = now();
	const s = liveStats(squads, input.fixtures, matches, seed, model);
	const elapsed = now() - t0;
	const failed: string[] = [];
	const gate = (name: string, ok: boolean) => {
		if (!ok) failed.push(name);
		return ok ? "PASS" : "FAIL";
	};
	const row = (
		label: string,
		live: number,
		kickoff: number,
		range: string,
		pf: string,
		d = 2,
	) =>
		`${label.padEnd(18)} ${f(live, d).padStart(7)} ${(Number.isNaN(kickoff) ? "—" : f(kickoff, d)).padStart(8)} ${range.padStart(9)} ${pf}`;
	const lines = [
		`kalibracja live ${input.season}: meczów ${s.matches}, seed ${seed}, ${Math.round(elapsed)} ms, AI po obu stronach, freshState`,
		`${"metryka".padEnd(18)} ${"live".padStart(7)} ${"kickoff".padStart(8)} ${"PRD".padStart(9)} wynik`,
		row(
			"gole/mecz",
			s.goalsPerMatch,
			s.kickoff.goalsPerMatch,
			`${GOALS_RANGE[0]}–${GOALS_RANGE[1]}`,
			gate("goalsPerMatch", inRange(s.goalsPerMatch, GOALS_RANGE)),
		),
		row(
			"wygrane gosp. %",
			s.homeWinPct,
			s.kickoff.homeWinPct,
			`${HOME_WIN_PCT_RANGE[0]}–${HOME_WIN_PCT_RANGE[1]}`,
			gate("homeWinPct", inRange(s.homeWinPct, HOME_WIN_PCT_RANGE)),
			1,
		),
		row(
			"remisy %",
			s.drawPct,
			s.kickoff.drawPct,
			`${DRAW_PCT_RANGE[0]}–${DRAW_PCT_RANGE[1]}`,
			gate("drawPct", inRange(s.drawPct, DRAW_PCT_RANGE)),
			1,
		),
		row("wygrane gości %", s.awayWinPct, Number.NaN, "", "info", 1),
		row("zmiany/mecz", s.subsPerMatch, Number.NaN, "", "info", 2),
		row("żółte/mecz", s.yellowsPerMatch, Number.NaN, "", "info", 2),
		row("czerwone/mecz", s.redsPerMatch, Number.NaN, "", "info", 3),
		row("kontuzje/mecz", s.injuriesPerMatch, Number.NaN, "", "info", 2),
		`LIVE_MODEL: zmęczenie ${model.fatiguePer90}/90 (×${1 + model.fatigueLowFitness} przy kondycji 0), zmiany AI od ${model.aiSubFrom}' co ≥${model.aiSubGap} min, maks. ${model.aiFatigueSubs} (+kontuzje, limit ${model.maxSubs}), ławka ${model.benchSize}, extraCap ${model.extraCap}`,
		failed.length === 0 ? "→ PASS" : `→ FAIL (${failed.join(", ")})`,
	];
	return { lines, exitCode: failed.length === 0 ? 0 : 3 };
}
