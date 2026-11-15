// DB layer for the round screen and the club list: thin SQL, the logic lives in round-screen.ts.

import { eq, sql } from "drizzle-orm";

import type { Db } from "~/import/api-football/load";
import { gameLiveMatch } from "~/server/db/schema";
import type { LiveStatus } from "./match-flow";
import type { RoundScreenInput } from "./round-screen";

export const PREMIER_LEAGUE_API_ID = 39;

/** Latest loaded season of the league (max(season)); null when none is loaded. */
export async function latestSeasonId(db: Db): Promise<number | null> {
	const rows = await db.execute<{ id: number }>(
		sql`select id from dugout_competition_season
			where league_api_id = ${PREMIER_LEAGUE_API_ID}
			order by season desc limit 1`,
	);
	return rows[0]?.id ?? null;
}

/** Clubs appearing in the fixtures of a season, alphabetical. */
export async function loadSeasonClubs(
	db: Db,
	competitionSeasonId: number,
): Promise<{ clubId: number; name: string; logoUrl: string | null }[]> {
	const rows = await db.execute<{
		club_id: number;
		name: string;
		logo_url: string | null;
	}>(
		sql`with season_clubs as (
				select home_club_id as club_id from dugout_fixture where competition_season_id = ${competitionSeasonId}
				union
				select away_club_id from dugout_fixture where competition_season_id = ${competitionSeasonId}
			)
			select c.id as club_id, c.name, c.logo_url
			from season_clubs sc join dugout_club c on c.id = sc.club_id order by c.name`,
	);
	return rows.map((r) => ({
		clubId: r.club_id,
		name: r.name,
		logoUrl: r.logo_url,
	}));
}

/** Null when the game does not exist. */
export async function loadRoundScreenInput(
	db: Db,
	gameId: number,
): Promise<RoundScreenInput | null> {
	const gameRows = await db.execute<{
		club_id: number;
		current_round: number;
		competition_season_id: number;
	}>(
		sql`select club_id, current_round, competition_season_id from dugout_game where id = ${gameId}`,
	);
	const g = gameRows[0];
	if (!g) return null;

	const clubs = await loadSeasonClubs(db, g.competition_season_id);
	const fixtureRows = await db.execute<{
		id: number;
		round: number;
		kickoff_at: Date;
		home_club_id: number;
		away_club_id: number;
	}>(
		sql`select id, round, kickoff_at, home_club_id, away_club_id from dugout_fixture
			where competition_season_id = ${g.competition_season_id}`,
	);
	const resultRows = await db.execute<{
		fixture_id: number;
		home_goals: number;
		away_goals: number;
	}>(
		sql`select fixture_id, home_goals, away_goals from dugout_game_result where game_id = ${gameId}`,
	);
	const [live] = await db
		.select({
			status: gameLiveMatch.status,
			round: gameLiveMatch.round,
			fixtureId: gameLiveMatch.fixtureId,
			changes: gameLiveMatch.changes,
		})
		.from(gameLiveMatch)
		.where(eq(gameLiveMatch.gameId, gameId));

	return {
		clubId: g.club_id,
		currentRound: g.current_round,
		totalRounds: fixtureRows.reduce((m, f) => Math.max(m, f.round), 0),
		clubs: clubs.map((c) => ({ clubId: c.clubId, name: c.name })),
		fixtures: fixtureRows.map((f) => ({
			fixtureId: f.id,
			round: f.round,
			kickoffAt: new Date(f.kickoff_at),
			homeClubId: f.home_club_id,
			awayClubId: f.away_club_id,
		})),
		results: resultRows.map((r) => ({
			fixtureId: r.fixture_id,
			homeGoals: r.home_goals,
			awayGoals: r.away_goals,
		})),
		liveMatch: live
			? {
					status: live.status as LiveStatus,
					round: live.round,
					fixtureId: live.fixtureId,
					changes: live.changes,
				}
			: null,
	};
}
