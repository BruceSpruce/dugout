// Leagues offered in the new-game screen: a pure aggregate -> row mapping plus one SQL loader.

import { sql } from "drizzle-orm";

import type { Db } from "~/import/api-football/load";
import { OPEN_LEAGUES } from "~/import/openfootball/leagues";

/** A club counts as having a squad with at least this many squad_member rows in the season. */
export const MIN_SQUAD_SIZE = 11;

export type LeagueAggregate = {
	competitionSeasonId: number;
	leagueApiId: number;
	name: string;
	country: string | null;
	season: number;
	clubCount: number;
	clubsWithSquad: number;
};

export type LeagueRow = {
	competitionSeasonId: number;
	name: string;
	country: string | null;
	season: number;
	clubCount: number;
	playable: boolean;
};

/** Playable leagues first, then OPEN_LEAGUES order, unknown leagues last by name. */
export function leagueRows(aggregates: LeagueAggregate[]): LeagueRow[] {
	const order = new Map(OPEN_LEAGUES.map((l, i) => [l.leagueApiId, i]));
	const rows = aggregates.map((a) => ({
		agg: a,
		row: {
			competitionSeasonId: a.competitionSeasonId,
			name: a.name,
			country: a.country,
			season: a.season,
			clubCount: a.clubCount,
			playable: a.clubCount > 0 && a.clubsWithSquad === a.clubCount,
		} satisfies LeagueRow,
	}));
	rows.sort((x, y) => {
		if (x.row.playable !== y.row.playable) return x.row.playable ? -1 : 1;
		const ox = order.get(x.agg.leagueApiId) ?? Number.POSITIVE_INFINITY;
		const oy = order.get(y.agg.leagueApiId) ?? Number.POSITIVE_INFINITY;
		if (ox !== oy) return ox < oy ? -1 : 1;
		return x.row.name.localeCompare(y.row.name) || y.row.season - x.row.season;
	});
	return rows.map((r) => r.row);
}

/** Competition seasons with at least one fixture, with club and squad counts (one query). */
export async function loadLeagueAggregates(db: Db): Promise<LeagueAggregate[]> {
	const rows = await db.execute<{
		id: number;
		league_api_id: number;
		name: string;
		country: string | null;
		season: number;
		club_count: number;
		clubs_with_squad: number;
	}>(
		sql`with season_clubs as (
				select competition_season_id as cs, home_club_id as club_id from dugout_fixture
				union
				select competition_season_id, away_club_id from dugout_fixture
			),
			squads as (
				select competition_season_id as cs, club_id, count(*) as n
				from dugout_squad_member group by competition_season_id, club_id
			)
			select s.id, s.league_api_id, s.name, s.country, s.season,
				count(sc.club_id)::int as club_count,
				count(sq.club_id) filter (where sq.n >= ${MIN_SQUAD_SIZE})::int as clubs_with_squad
			from dugout_competition_season s
			join season_clubs sc on sc.cs = s.id
			left join squads sq on sq.cs = s.id and sq.club_id = sc.club_id
			group by s.id`,
	);
	return rows.map((r) => ({
		competitionSeasonId: r.id,
		leagueApiId: r.league_api_id,
		name: r.name,
		country: r.country,
		season: r.season,
		clubCount: r.club_count,
		clubsWithSquad: r.clubs_with_squad,
	}));
}

export async function loadLeagues(db: Db): Promise<LeagueRow[]> {
	return leagueRows(await loadLeagueAggregates(db));
}
