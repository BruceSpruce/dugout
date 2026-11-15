// DB layer for the round flow: thin SQL, the logic lives in match-flow.ts.

import { and, eq, sql } from "drizzle-orm";

import { computeAttributes, type PlayerAttributes } from "~/engine/attributes";
import type { Db } from "~/import/api-football/load";
import {
	gameLineup,
	gameLiveMatch,
	gamePlayerState,
	gameResult,
} from "~/server/db/schema";
import { loadAttributesInput } from "~/server/engine-input/attributes-input";
import { loadPlayerStates } from "./lineup";
import { loadSeasonClubs } from "./load-round-screen";
import type {
	ClubName,
	FlowFixture,
	LiveMatchRow,
	LiveStatus,
	PlayedResult,
	RoundFinish,
	StartInput,
} from "./match-flow";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** The database or a transaction. */
export type DbOrTx = Db | Tx;

type GameRow = {
	clubId: number;
	currentRound: number;
	competitionSeasonId: number;
	leagueApiId: number;
	season: number;
};

async function loadGame(db: Db, gameId: number): Promise<GameRow | null> {
	const rows = await db.execute<{
		club_id: number;
		current_round: number;
		competition_season_id: number;
		league_api_id: number;
		season: number;
	}>(
		sql`select g.club_id, g.current_round, g.competition_season_id, cs.league_api_id, cs.season
			from dugout_game g join dugout_competition_season cs on cs.id = g.competition_season_id
			where g.id = ${gameId}`,
	);
	const g = rows[0];
	if (!g) return null;
	return {
		clubId: g.club_id,
		currentRound: g.current_round,
		competitionSeasonId: g.competition_season_id,
		leagueApiId: g.league_api_id,
		season: g.season,
	};
}

const asRow = (r: typeof gameLiveMatch.$inferSelect): LiveMatchRow => ({
	gameId: r.gameId,
	fixtureId: r.fixtureId,
	round: r.round,
	seed: r.seed,
	setup: r.setup,
	background: r.background,
	changes: r.changes,
	minute: r.minute,
	status: r.status as LiveStatus,
});

export async function loadLiveRow(
	db: Db,
	gameId: number,
): Promise<LiveMatchRow | null> {
	const [r] = await db
		.select()
		.from(gameLiveMatch)
		.where(eq(gameLiveMatch.gameId, gameId));
	return r ? asRow(r) : null;
}

/** Live row locked for update (inside a transaction), only when status = live. */
export async function lockLiveRow(
	db: DbOrTx,
	gameId: number,
): Promise<LiveMatchRow | null> {
	const [r] = await db
		.select()
		.from(gameLiveMatch)
		.where(
			and(eq(gameLiveMatch.gameId, gameId), eq(gameLiveMatch.status, "live")),
		)
		.for("update");
	return r ? asRow(r) : null;
}

/**
 * Like lockLiveRow, plus the row's updated_at and the database clock (now(), the transaction
 * start), so the abandon rule does not depend on the app server's clock.
 */
export async function lockLiveRowAged(
	db: DbOrTx,
	gameId: number,
): Promise<{ row: LiveMatchRow; updatedAt: Date; dbNow: Date } | null> {
	const [r] = await db
		.select({ live: gameLiveMatch, dbNow: sql<string | Date>`now()` })
		.from(gameLiveMatch)
		.where(
			and(eq(gameLiveMatch.gameId, gameId), eq(gameLiveMatch.status, "live")),
		)
		.for("update");
	if (!r) return null;
	return {
		row: asRow(r.live),
		updatedAt: r.live.updatedAt,
		dbNow: new Date(r.dbNow),
	};
}

/** Everything startRound needs except the seed; null when the game or its season is missing. */
export async function loadStartInput(
	db: Db,
	gameId: number,
): Promise<Omit<StartInput, "seed"> | null> {
	const g = await loadGame(db, gameId);
	if (!g) return null;
	const attrs = await loadAttributesInput(db, g.leagueApiId, g.season);
	if (!attrs) return null;
	const squads = new Map<number, PlayerAttributes[]>();
	for (const p of computeAttributes(attrs.players)) {
		const list = squads.get(p.clubId);
		if (list) list.push(p);
		else squads.set(p.clubId, [p]);
	}
	const fixtureRows = await db.execute<{
		id: number;
		round: number;
		home_club_id: number;
		away_club_id: number;
	}>(
		sql`select id, round, home_club_id, away_club_id from dugout_fixture
			where competition_season_id = ${g.competitionSeasonId} and round = ${g.currentRound}`,
	);
	const fixtures: FlowFixture[] = fixtureRows.map((f) => ({
		fixtureId: f.id,
		round: f.round,
		homeClubId: f.home_club_id,
		awayClubId: f.away_club_id,
	}));
	const [saved] = await db
		.select({
			formation: gameLineup.formation,
			style: gameLineup.style,
			starters: gameLineup.starters,
			bench: gameLineup.bench,
		})
		.from(gameLineup)
		.where(eq(gameLineup.gameId, gameId));
	const [existing] = await db
		.select({ status: gameLiveMatch.status })
		.from(gameLiveMatch)
		.where(eq(gameLiveMatch.gameId, gameId));
	return {
		gameId,
		clubId: g.clubId,
		currentRound: g.currentRound,
		fixtures,
		squads,
		states: await loadPlayerStates(db, gameId),
		lineup: saved ?? null,
		existing: (existing?.status as LiveStatus | undefined) ?? null,
	};
}

export const ROUND_MOVED =
	"Kolejka została już zapisana (gra jest w innej kolejce).";

/**
 * Writes a new live row, overwriting only a finished one. False when a live match already
 * exists (also under a concurrent start).
 */
export async function insertLiveRow(
	db: Db,
	row: LiveMatchRow,
): Promise<boolean> {
	const values = {
		fixtureId: row.fixtureId,
		round: row.round,
		seed: row.seed,
		setup: row.setup,
		background: row.background,
		changes: row.changes,
		minute: row.minute,
		status: row.status,
	};
	const written = await db
		.insert(gameLiveMatch)
		.values({ gameId: row.gameId, ...values })
		.onConflictDoUpdate({
			target: gameLiveMatch.gameId,
			set: { ...values, updatedAt: sql`now()` },
			// Only a finished row of an earlier round: a start that read a stale current_round
			// (concurrent finish) must not replay the round that was just written.
			setWhere: and(
				eq(gameLiveMatch.status, "finished"),
				sql`${gameLiveMatch.round} < excluded.round`,
			),
		})
		.returning({ gameId: gameLiveMatch.gameId });
	return written.length > 0;
}

export async function updateLiveProgress(
	db: DbOrTx,
	gameId: number,
	values: { minute?: number; changes?: LiveMatchRow["changes"] },
): Promise<void> {
	await db
		.update(gameLiveMatch)
		.set({ ...values, updatedAt: sql`now()` })
		.where(
			and(eq(gameLiveMatch.gameId, gameId), eq(gameLiveMatch.status, "live")),
		);
}

/** Clubs of the game's season and its results of earlier rounds (for the live table). */
export async function loadViewContext(
	db: Db,
	gameId: number,
): Promise<{ clubs: ClubName[]; results: PlayedResult[] } | null> {
	const g = await loadGame(db, gameId);
	if (!g) return null;
	const clubs = await loadSeasonClubs(db, g.competitionSeasonId);
	const rows = await db.execute<{
		fixture_id: number;
		home_club_id: number;
		away_club_id: number;
		home_goals: number;
		away_goals: number;
	}>(
		sql`select r.fixture_id, f.home_club_id, f.away_club_id, r.home_goals, r.away_goals
			from dugout_game_result r join dugout_fixture f on f.id = r.fixture_id
			where r.game_id = ${gameId}`,
	);
	return {
		clubs: clubs.map((c) => ({ clubId: c.clubId, name: c.name })),
		results: rows.map((r) => ({
			fixtureId: r.fixture_id,
			homeClubId: r.home_club_id,
			awayClubId: r.away_club_id,
			homeGoals: r.home_goals,
			awayGoals: r.away_goals,
		})),
	};
}

/**
 * Atomic takeover of the end of the round (plan-review F2): flips a live row at minute 90 to
 * finished and returns it; null when there is none (not live, not at 90, already finished).
 */
export async function claimFinish(
	db: DbOrTx,
	gameId: number,
): Promise<LiveMatchRow | null> {
	const [r] = await db
		.update(gameLiveMatch)
		.set({ status: "finished", updatedAt: sql`now()` })
		.where(
			and(
				eq(gameLiveMatch.gameId, gameId),
				eq(gameLiveMatch.status, "live"),
				eq(gameLiveMatch.minute, 90),
			),
		)
		.returning();
	return r ? asRow(r) : null;
}

const STATE_CHUNK = 1000;

/** Writes the round: results (on conflict do nothing), player states (upsert), current_round = round + 1. */
export async function writeRoundFinish(
	db: DbOrTx,
	gameId: number,
	finish: RoundFinish,
): Promise<void> {
	if (finish.results.length > 0) {
		await db
			.insert(gameResult)
			.values(finish.results.map((r) => ({ gameId, ...r })))
			.onConflictDoNothing({
				target: [gameResult.gameId, gameResult.fixtureId],
			});
	}
	for (let i = 0; i < finish.states.length; i += STATE_CHUNK) {
		const chunk = finish.states.slice(i, i + STATE_CHUNK);
		await db
			.insert(gamePlayerState)
			.values(
				chunk.map(({ playerId, state }) => ({
					gameId,
					playerId,
					fitness: state.fitness,
					form: state.form,
					yellowCount: state.yellowCount,
					suspendedFor: state.suspendedFor,
					injuredFor: state.injuredFor,
				})),
			)
			.onConflictDoUpdate({
				target: [gamePlayerState.gameId, gamePlayerState.playerId],
				set: {
					fitness: sql`excluded.fitness`,
					form: sql`excluded.form`,
					yellowCount: sql`excluded.yellow_count`,
					suspendedFor: sql`excluded.suspended_for`,
					injuredFor: sql`excluded.injured_for`,
				},
			});
	}
	const advanced = await db.execute(
		sql`update dugout_game set current_round = ${finish.nextRound}
			where id = ${gameId} and current_round = ${finish.nextRound - 1}
			returning id`,
	);
	if (advanced.length === 0) {
		// Throwing rolls back the whole finish transaction.
		throw new Error(ROUND_MOVED);
	}
}
