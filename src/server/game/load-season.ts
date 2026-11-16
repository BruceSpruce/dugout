// DB layer for the season summary and game history: thin SQL, the logic lives in season-summary.ts.

import { sql } from "drizzle-orm";

import type { FixtureResult } from "~/engine/club-strength";
import type { Db } from "~/import/api-football/load";
import { loadSeasonClubs } from "./load-round-screen";

export type SeasonGame = {
	clubId: number;
	seasonNo: number;
	clubs: { clubId: number; name: string }[];
};

/** The game's club, current season and the clubs of its competition season; null when no game. */
export async function loadSeasonGame(
	db: Db,
	gameId: number,
): Promise<SeasonGame | null> {
	const rows = await db.execute<{
		club_id: number;
		season_no: number;
		competition_season_id: number;
	}>(
		sql`select club_id, season_no, competition_season_id from dugout_game where id = ${gameId}`,
	);
	const g = rows[0];
	if (!g) return null;
	const clubs = await loadSeasonClubs(db, g.competition_season_id);
	return {
		clubId: g.club_id,
		seasonNo: g.season_no,
		clubs: clubs.map((c) => ({ clubId: c.clubId, name: c.name })),
	};
}

/** Results of one season of the game, with the fixture's clubs. */
export async function loadSeasonResults(
	db: Db,
	gameId: number,
	seasonNo: number,
): Promise<FixtureResult[]> {
	const rows = await db.execute<{
		home_club_id: number;
		away_club_id: number;
		home_goals: number;
		away_goals: number;
	}>(
		sql`select f.home_club_id, f.away_club_id, r.home_goals, r.away_goals
			from dugout_game_result r join dugout_fixture f on f.id = r.fixture_id
			where r.game_id = ${gameId} and r.season_no = ${seasonNo}`,
	);
	return rows.map((r) => ({
		homeClubId: r.home_club_id,
		awayClubId: r.away_club_id,
		homeGoals: r.home_goals,
		awayGoals: r.away_goals,
	}));
}

/** Results of all completed seasons (season_no < the game's current season_no). */
export async function loadCompletedResults(
	db: Db,
	gameId: number,
	currentSeasonNo: number,
): Promise<(FixtureResult & { seasonNo: number })[]> {
	const rows = await db.execute<{
		season_no: number;
		home_club_id: number;
		away_club_id: number;
		home_goals: number;
		away_goals: number;
	}>(
		sql`select r.season_no, f.home_club_id, f.away_club_id, r.home_goals, r.away_goals
			from dugout_game_result r join dugout_fixture f on f.id = r.fixture_id
			where r.game_id = ${gameId} and r.season_no < ${currentSeasonNo}`,
	);
	return rows.map((r) => ({
		seasonNo: r.season_no,
		homeClubId: r.home_club_id,
		awayClubId: r.away_club_id,
		homeGoals: r.home_goals,
		awayGoals: r.away_goals,
	}));
}
