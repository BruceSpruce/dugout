// Engine input for the calibration report: everything `loadAttributesInput` returns plus the
// full season schedule (round, home, away).

import { sql } from "drizzle-orm";

import type { SeasonFixture } from "~/engine/season";
import type { Db } from "~/import/api-football/load";
import { type AttributesInput, loadAttributesInput } from "./attributes-input";

export type SeasonInput = AttributesInput & { fixtures: SeasonFixture[] };

/** Null when the season is not loaded (no competition_season row). */
export async function loadSeasonInput(
	db: Db,
	league: number,
	season: number,
): Promise<SeasonInput | null> {
	const base = await loadAttributesInput(db, league, season);
	if (!base) return null;
	const seasonRows = await db.execute<{ id: number }>(
		sql`select id from dugout_competition_season
			where league_api_id = ${league} and season = ${season}`,
	);
	const id = seasonRows[0]?.id;
	if (id === undefined) return null;
	const rows = await db.execute<{
		round: number;
		home_club_id: number;
		away_club_id: number;
	}>(
		sql`select round, home_club_id, away_club_id from dugout_fixture
			where competition_season_id = ${id}
			order by round, kickoff_at, id`,
	);
	return {
		...base,
		fixtures: rows.map((r) => ({
			round: Number(r.round),
			homeClubId: r.home_club_id,
			awayClubId: r.away_club_id,
		})),
	};
}
