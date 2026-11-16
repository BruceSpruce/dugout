// Drizzle schema. Every table goes through `createTable`, which prefixes names with `dugout_`
// (drizzle.config.ts filters on that prefix). Change the schema via `npm run db:generate` +
// `npm run db:migrate`; migrations live in `drizzle/` and are committed.

import {
	date,
	index,
	integer,
	jsonb,
	numeric,
	pgTableCreator,
	primaryKey,
	real,
	text,
	timestamp,
	unique,
} from "drizzle-orm/pg-core";

import type { LiveChange, LiveSetup } from "~/engine/live-match";
import type { StoredBackground } from "~/server/game/match-flow";

export const createTable = pgTableCreator((name) => `dugout_${name}`);

// Competition-independent import tables: API ids are the natural keys used for upserts.

export const competitionSeason = createTable(
	"competition_season",
	{
		id: integer().primaryKey().generatedByDefaultAsIdentity(),
		leagueApiId: integer("league_api_id").notNull(),
		// Start year of the season (2024 = 2024/25).
		season: integer().notNull(),
		name: text().notNull(),
		country: text(),
		startsOn: date("starts_on", { mode: "string" }),
		endsOn: date("ends_on", { mode: "string" }),
	},
	(t) => [
		unique("competition_season_league_season_uq").on(t.leagueApiId, t.season),
	],
);

export const club = createTable("club", {
	id: integer().primaryKey().generatedByDefaultAsIdentity(),
	apiId: integer("api_id").notNull().unique(),
	name: text().notNull(),
	code: text(),
	country: text(),
	logoUrl: text("logo_url"),
});

export const player = createTable("player", {
	id: integer().primaryKey().generatedByDefaultAsIdentity(),
	apiId: integer("api_id").notNull().unique(),
	firstName: text("first_name"),
	lastName: text("last_name"),
	name: text().notNull(),
	birthDate: date("birth_date", { mode: "string" }),
	nationality: text(),
	heightCm: integer("height_cm"),
	weightKg: integer("weight_kg"),
});

const counter = (column: string) => integer(column).notNull().default(0);

export const playerSeasonStats = createTable(
	"player_season_stats",
	{
		id: integer().primaryKey().generatedByDefaultAsIdentity(),
		playerId: integer("player_id")
			.notNull()
			.references(() => player.id),
		clubId: integer("club_id")
			.notNull()
			.references(() => club.id),
		competitionSeasonId: integer("competition_season_id")
			.notNull()
			.references(() => competitionSeason.id),
		position: text(),
		appearances: counter("appearances"),
		lineups: counter("lineups"),
		minutes: counter("minutes"),
		subsIn: counter("subs_in"),
		subsOut: counter("subs_out"),
		bench: counter("bench"),
		shotsTotal: counter("shots_total"),
		shotsOn: counter("shots_on"),
		goals: counter("goals"),
		goalsConceded: counter("goals_conceded"),
		assists: counter("assists"),
		saves: counter("saves"),
		passesTotal: counter("passes_total"),
		passesKey: counter("passes_key"),
		tackles: counter("tackles"),
		blocks: counter("blocks"),
		interceptions: counter("interceptions"),
		duels: counter("duels"),
		duelsWon: counter("duels_won"),
		dribblesAttempts: counter("dribbles_attempts"),
		dribblesSuccess: counter("dribbles_success"),
		dribblesPast: counter("dribbles_past"),
		foulsDrawn: counter("fouls_drawn"),
		foulsCommitted: counter("fouls_committed"),
		yellowCards: counter("yellow_cards"),
		yellowRedCards: counter("yellow_red_cards"),
		redCards: counter("red_cards"),
		penaltyWon: counter("penalty_won"),
		penaltyCommitted: counter("penalty_committed"),
		penaltyScored: counter("penalty_scored"),
		penaltyMissed: counter("penalty_missed"),
		penaltySaved: counter("penalty_saved"),
		rating: numeric({ precision: 5, scale: 3, mode: "number" }),
		// API's passes.accuracy as received (meaning differs per response), not interpreted.
		passesAccuracyRaw: integer("passes_accuracy_raw"),
	},
	(t) => [
		unique("player_season_stats_uq").on(
			t.playerId,
			t.clubId,
			t.competitionSeasonId,
		),
	],
);

export const squadMember = createTable(
	"squad_member",
	{
		id: integer().primaryKey().generatedByDefaultAsIdentity(),
		competitionSeasonId: integer("competition_season_id")
			.notNull()
			.references(() => competitionSeason.id),
		playerId: integer("player_id")
			.notNull()
			.references(() => player.id),
		// The club the player counts for in the game (see normalizePlayers).
		clubId: integer("club_id")
			.notNull()
			.references(() => club.id),
		position: text(),
	},
	(t) => [
		unique("squad_member_uq").on(t.competitionSeasonId, t.playerId),
		// Squad of one club in one season.
		index("squad_member_club_season_idx").on(t.clubId, t.competitionSeasonId),
	],
);

export const fixture = createTable(
	"fixture",
	{
		id: integer().primaryKey().generatedByDefaultAsIdentity(),
		apiId: integer("api_id").notNull().unique(),
		competitionSeasonId: integer("competition_season_id")
			.notNull()
			.references(() => competitionSeason.id),
		round: integer().notNull(),
		kickoffAt: timestamp("kickoff_at", {
			withTimezone: true,
			mode: "date",
		}).notNull(),
		status: text().notNull(),
		homeClubId: integer("home_club_id")
			.notNull()
			.references(() => club.id),
		awayClubId: integer("away_club_id")
			.notNull()
			.references(() => club.id),
		// Null for fixtures not played yet.
		homeGoals: integer("home_goals"),
		awayGoals: integer("away_goals"),
		homeGoalsHt: integer("home_goals_ht"),
		awayGoalsHt: integer("away_goals_ht"),
	},
	(t) => [
		// Round screen: fixtures of one season by round.
		index("fixture_season_round_idx").on(t.competitionSeasonId, t.round),
		index("fixture_home_club_idx").on(t.homeClubId),
		index("fixture_away_club_idx").on(t.awayClubId),
	],
);

// Game state. Results are the game's own, never the real fixture goals.

export const game = createTable(
	"game",
	{
		id: integer().primaryKey().generatedByDefaultAsIdentity(),
		competitionSeasonId: integer("competition_season_id")
			.notNull()
			.references(() => competitionSeason.id),
		clubId: integer("club_id")
			.notNull()
			.references(() => club.id),
		currentRound: integer("current_round").notNull().default(1),
		// Season of the game, from 1; every season replays the same fixtures.
		seasonNo: integer("season_no").notNull().default(1),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.notNull()
			.defaultNow(),
	},
	(t) => [index("game_competition_season_idx").on(t.competitionSeasonId)],
);

export const gameResult = createTable(
	"game_result",
	{
		id: integer().primaryKey().generatedByDefaultAsIdentity(),
		gameId: integer("game_id")
			.notNull()
			.references(() => game.id, { onDelete: "cascade" }),
		seasonNo: integer("season_no").notNull(),
		fixtureId: integer("fixture_id")
			.notNull()
			.references(() => fixture.id),
		homeGoals: integer("home_goals").notNull(),
		awayGoals: integer("away_goals").notNull(),
	},
	(t) => [
		unique("game_result_game_season_fixture_uq").on(
			t.gameId,
			t.seasonNo,
			t.fixtureId,
		),
		index("game_result_fixture_idx").on(t.fixtureId),
	],
);

// One saved lineup per game: starters in the slot order of the formation, bench of 0-9.
export const gameLineup = createTable("game_lineup", {
	gameId: integer("game_id")
		.primaryKey()
		.references(() => game.id, { onDelete: "cascade" }),
	formation: text().notNull(),
	style: text().notNull(),
	starters: jsonb().$type<number[]>().notNull(),
	bench: jsonb().$type<number[]>().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
		.notNull()
		.defaultNow(),
});

// Player state between matches per game (cards, bans, injuries, fitness, form). No row = fresh state.
export const gamePlayerState = createTable(
	"game_player_state",
	{
		gameId: integer("game_id")
			.notNull()
			.references(() => game.id, { onDelete: "cascade" }),
		playerId: integer("player_id")
			.notNull()
			.references(() => player.id),
		fitness: real().notNull(),
		form: real().notNull(),
		yellowCount: integer("yellow_count").notNull(),
		suspendedFor: integer("suspended_for").notNull(),
		injuredFor: integer("injured_for").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.gameId, t.playerId] }),
		index("game_player_state_player_idx").on(t.playerId),
	],
);

// The user's match of the current round, replayed from (setup, seed, changes) up to `minute`.
// One row per game: `start` overwrites a finished row, `finish` flips status to finished.
export const gameLiveMatch = createTable(
	"game_live_match",
	{
		gameId: integer("game_id")
			.primaryKey()
			.references(() => game.id, { onDelete: "cascade" }),
		fixtureId: integer("fixture_id")
			.notNull()
			.references(() => fixture.id),
		seasonNo: integer("season_no").notNull(),
		round: integer().notNull(),
		seed: integer().notNull(),
		setup: jsonb().$type<LiveSetup>().notNull(),
		background: jsonb().$type<StoredBackground>().notNull(),
		changes: jsonb().$type<LiveChange[]>().notNull(),
		minute: integer().notNull(),
		// live | finished
		status: text().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
			.notNull()
			.defaultNow(),
	},
	(t) => [index("game_live_match_fixture_idx").on(t.fixtureId)],
);
