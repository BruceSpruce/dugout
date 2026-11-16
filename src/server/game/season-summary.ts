// Season summary and game history: pure functions over the game's own results, no DB.

import {
	type FixtureResult,
	leagueTable,
	type TableRow,
} from "~/engine/club-strength";
import { leagueStats } from "~/engine/season";

type Club = { clubId: number; name: string };

export type SummaryRow = TableRow & {
	won: number;
	drawn: number;
	lost: number;
	goalsAgainst: number;
};

export type SeasonSummary = {
	seasonNo: number;
	champion: string;
	table: SummaryRow[];
	user: {
		position: number;
		points: number;
		won: number;
		drawn: number;
		lost: number;
		goalsFor: number;
		goalsAgainst: number;
	};
	stats: {
		matches: number;
		goalsPerMatch: number;
		homeWinPct: number;
		drawPct: number;
		awayWinPct: number;
	};
};

export type GameHistory = {
	seasons: {
		seasonNo: number;
		champion: string;
		position: number;
		points: number;
		won: number;
		drawn: number;
		lost: number;
		goalsFor: number;
		goalsAgainst: number;
	}[];
	allTime: {
		clubId: number;
		name: string;
		seasons: number;
		titles: number;
		played: number;
		won: number;
		drawn: number;
		lost: number;
		goalsFor: number;
		goalsAgainst: number;
		points: number;
	}[];
};

/** W/D/L and goals against per club (leagueTable carries neither). */
function recordOf(results: FixtureResult[]) {
	const rec = new Map<
		number,
		{ won: number; drawn: number; lost: number; goalsAgainst: number }
	>();
	const apply = (id: number, gf: number, ga: number) => {
		const r = rec.get(id) ?? { won: 0, drawn: 0, lost: 0, goalsAgainst: 0 };
		if (gf > ga) r.won += 1;
		else if (gf === ga) r.drawn += 1;
		else r.lost += 1;
		r.goalsAgainst += ga;
		rec.set(id, r);
	};
	for (const r of results) {
		apply(r.homeClubId, r.homeGoals, r.awayGoals);
		apply(r.awayClubId, r.awayGoals, r.homeGoals);
	}
	return rec;
}

/** Table (same order as the round screen), champion, the user's line and league stats. */
export function seasonSummary(input: {
	seasonNo: number;
	clubs: Club[];
	results: FixtureResult[];
	userClubId: number;
}): SeasonSummary {
	const { seasonNo, clubs, results, userClubId } = input;
	const rec = recordOf(results);
	const table: SummaryRow[] = leagueTable(results, clubs).map((row) => ({
		...row,
		...(rec.get(row.clubId) ?? { won: 0, drawn: 0, lost: 0, goalsAgainst: 0 }),
	}));
	const u = table.find((r) => r.clubId === userClubId);
	const s = leagueStats(results, clubs);
	return {
		seasonNo,
		champion: table[0]?.name ?? "",
		table,
		user: {
			position: u?.position ?? 0,
			points: u?.points ?? 0,
			won: u?.won ?? 0,
			drawn: u?.drawn ?? 0,
			lost: u?.lost ?? 0,
			goalsFor: u?.goalsFor ?? 0,
			goalsAgainst: u?.goalsAgainst ?? 0,
		},
		stats: {
			matches: s.matches,
			goalsPerMatch: s.goalsPerMatch,
			homeWinPct: s.homeWinPct,
			drawPct: s.drawPct,
			awayWinPct: s.awayWinPct,
		},
	};
}

/**
 * Completed seasons (the caller passes only season_no < the game's season_no) and the
 * all-time table, ordered by points, goal difference, goals for, name.
 */
export function gameHistory(input: {
	clubs: Club[];
	seasons: { seasonNo: number; results: FixtureResult[] }[];
	userClubId: number;
}): GameHistory {
	const { clubs, userClubId } = input;
	const sorted = [...input.seasons].sort((a, b) => a.seasonNo - b.seasonNo);
	const all = new Map<number, GameHistory["allTime"][number]>();
	const seasons: GameHistory["seasons"] = [];
	for (const season of sorted) {
		const s = seasonSummary({
			seasonNo: season.seasonNo,
			clubs,
			results: season.results,
			userClubId,
		});
		seasons.push({ seasonNo: s.seasonNo, champion: s.champion, ...s.user });
		for (const row of s.table) {
			const a = all.get(row.clubId) ?? {
				clubId: row.clubId,
				name: row.name,
				seasons: 0,
				titles: 0,
				played: 0,
				won: 0,
				drawn: 0,
				lost: 0,
				goalsFor: 0,
				goalsAgainst: 0,
				points: 0,
			};
			a.seasons += 1;
			if (row.position === 1) a.titles += 1;
			a.played += row.played;
			a.won += row.won;
			a.drawn += row.drawn;
			a.lost += row.lost;
			a.goalsFor += row.goalsFor;
			a.goalsAgainst += row.goalsAgainst;
			a.points += row.points;
			all.set(row.clubId, a);
		}
	}
	const allTime = [...all.values()].sort(
		(a, b) =>
			b.points - a.points ||
			b.goalsFor - b.goalsAgainst - (a.goalsFor - a.goalsAgainst) ||
			b.goalsFor - a.goalsFor ||
			a.name.localeCompare(b.name),
	);
	return { seasons, allTime };
}

/** Groups result rows by season, keeping only completed seasons (seasonNo < current). */
export function completedSeasons(
	rows: (FixtureResult & { seasonNo: number })[],
	currentSeasonNo: number,
): { seasonNo: number; results: FixtureResult[] }[] {
	const bySeason = new Map<number, FixtureResult[]>();
	for (const { seasonNo, ...r } of rows) {
		if (seasonNo >= currentSeasonNo) continue;
		const list = bySeason.get(seasonNo) ?? [];
		list.push(r);
		bySeason.set(seasonNo, list);
	}
	return [...bySeason.entries()]
		.sort(([a], [b]) => a - b)
		.map(([seasonNo, results]) => ({ seasonNo, results }));
}
