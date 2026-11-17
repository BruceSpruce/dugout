// Engine input for one imported (league, season): `loadAttributesInput` is the thin SQL layer,
// `aggregatePlayerRows` is pure (stat rows + squad + played matches in, PlayerInput[] out).

import { sql } from "drizzle-orm";

import type { Counters, PlayerInput, Position } from "~/engine/attributes";
import type { FixtureResult } from "~/engine/club-strength";
import type { Db } from "~/import/api-football/load";

const MINUTES_PER_MATCH = 90;
const FALLBACK_POSITION: Position = "Midfielder";
const POSITIONS: readonly string[] = [
	"Goalkeeper",
	"Defender",
	"Midfielder",
	"Attacker",
];

const COUNTER_KEYS = [
	"goals",
	"penaltyScored",
	"shotsTotal",
	"shotsOn",
	"assists",
	"passesKey",
	"passesTotal",
	"dribblesSuccess",
	"tackles",
	"interceptions",
	"blocks",
	"duels",
	"duelsWon",
	"dribblesPast",
	"saves",
	"goalsConceded",
	"penaltySaved",
	"foulsCommitted",
	"yellowCards",
	"yellowRedCards",
	"redCards",
] as const satisfies readonly (keyof Counters)[];

/** One player_season_stats row (a player has several after a transfer). */
export type StatsRowInput = {
	playerId: number;
	clubId: number;
	position: string | null;
	minutes: number;
	rating: number | null;
	counters: Counters;
};

/** One squad_member row joined with the player name. */
export type SquadRowInput = {
	playerId: number;
	name: string;
	clubId: number;
	position: string | null;
};

const zeroCounters = (): Counters =>
	Object.fromEntries(COUNTER_KEYS.map((k) => [k, 0])) as Counters;

// API-Football returns "Forward" for some players next to the usual "Attacker" (PL 2024: 24 squads rows).
const POSITION_ALIASES: Readonly<Record<string, Position>> = {
	Forward: "Attacker",
};

const asPosition = (p: string | null): Position | null => {
	if (p === null) return null;
	const alias = POSITION_ALIASES[p];
	if (alias) return alias;
	return POSITIONS.includes(p) ? (p as Position) : null;
};

/**
 * One PlayerInput per squad member. Counters are summed over the player's rows; club and position
 * come from squad_member (null position: row with most minutes, else Midfielder). A squad member
 * without rows gets zero counters and 0 minutes.
 */
export function aggregatePlayerRows(
	rows: StatsRowInput[],
	squad: SquadRowInput[],
	clubPlayedMatches: Map<number, number>,
): PlayerInput[] {
	const byPlayer = new Map<number, StatsRowInput[]>();
	for (const r of rows) {
		const list = byPlayer.get(r.playerId);
		if (list) list.push(r);
		else byPlayer.set(r.playerId, [r]);
	}

	return squad.map((m) => {
		const own = byPlayer.get(m.playerId) ?? [];
		const counters = zeroCounters();
		let minutes = 0;
		let ratingSum = 0;
		let ratingMinutes = 0;
		let topRow: StatsRowInput | undefined;
		for (const r of own) {
			for (const k of COUNTER_KEYS) counters[k] += r.counters[k];
			minutes += r.minutes;
			if (r.rating !== null && r.minutes > 0) {
				ratingSum += r.rating * r.minutes;
				ratingMinutes += r.minutes;
			}
			if (!topRow || r.minutes > topRow.minutes) topRow = r;
		}
		const position =
			asPosition(m.position) ??
			asPosition(topRow?.position ?? null) ??
			FALLBACK_POSITION;
		return {
			playerId: m.playerId,
			name: m.name,
			clubId: m.clubId,
			position,
			minutes,
			ratingMinutes: ratingMinutes > 0 ? ratingSum / ratingMinutes : null,
			clubPlayedMinutes:
				(clubPlayedMatches.get(m.clubId) ?? 0) * MINUTES_PER_MATCH,
			counters,
		};
	});
}

export type AttributesInput = {
	players: PlayerInput[];
	clubs: { clubId: number; name: string; apiId: number | null }[];
	results: FixtureResult[];
};

type StatsSqlRow = {
	player_id: number;
	club_id: number;
	position: string | null;
	minutes: number;
	rating: number | null;
} & Record<(typeof COUNTER_KEYS)[number], number>;

const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** Null when the season is not loaded (no competition_season row). */
export async function loadAttributesInput(
	db: Db,
	league: number,
	season: number,
): Promise<AttributesInput | null> {
	const seasonRows = await db.execute<{ id: number }>(
		sql`select id from dugout_competition_season
			where league_api_id = ${league} and season = ${season}`,
	);
	const id = seasonRows[0]?.id;
	if (id === undefined) return null;

	const counterCols = sql.raw(
		COUNTER_KEYS.map((k) => `${snake(k)} as "${k}"`).join(", "),
	);
	const statRows = await db.execute<StatsSqlRow>(
		sql`select player_id, club_id, position, minutes, rating::float8 as rating, ${counterCols}
			from dugout_player_season_stats where competition_season_id = ${id}`,
	);
	const squadRows = await db.execute<{
		player_id: number;
		name: string;
		club_id: number;
		position: string | null;
	}>(
		sql`select m.player_id, p.name, m.club_id, m.position
			from dugout_squad_member m join dugout_player p on p.id = m.player_id
			where m.competition_season_id = ${id}`,
	);
	const clubRows = await db.execute<{
		club_id: number;
		name: string;
		api_id: number | null;
	}>(
		sql`with season_clubs as (
				select home_club_id as club_id from dugout_fixture where competition_season_id = ${id}
				union
				select away_club_id from dugout_fixture where competition_season_id = ${id}
			)
			select c.id as club_id, c.name, c.api_id
			from season_clubs sc join dugout_club c on c.id = sc.club_id order by c.name`,
	);
	const fixtureRows = await db.execute<{
		home_club_id: number;
		away_club_id: number;
		home_goals: number;
		away_goals: number;
	}>(
		sql`select home_club_id, away_club_id, home_goals, away_goals from dugout_fixture
			where competition_season_id = ${id} and home_goals is not null and away_goals is not null`,
	);

	const results: FixtureResult[] = fixtureRows.map((f) => ({
		homeClubId: f.home_club_id,
		awayClubId: f.away_club_id,
		homeGoals: f.home_goals,
		awayGoals: f.away_goals,
	}));
	const played = new Map<number, number>();
	for (const r of results) {
		played.set(r.homeClubId, (played.get(r.homeClubId) ?? 0) + 1);
		played.set(r.awayClubId, (played.get(r.awayClubId) ?? 0) + 1);
	}

	const stats: StatsRowInput[] = statRows.map((r) => {
		const counters = zeroCounters();
		for (const k of COUNTER_KEYS) counters[k] = Number(r[k] ?? 0);
		return {
			playerId: r.player_id,
			clubId: r.club_id,
			position: r.position,
			minutes: r.minutes,
			rating: r.rating === null ? null : Number(r.rating),
			counters,
		};
	});
	const squad: SquadRowInput[] = squadRows.map((r) => ({
		playerId: r.player_id,
		name: r.name,
		clubId: r.club_id,
		position: r.position,
	}));

	return {
		players: aggregatePlayerRows(stats, squad, played),
		clubs: clubRows.map((c) => ({
			clubId: c.club_id,
			name: c.name,
			apiId: c.api_id,
		})),
		results,
	};
}
