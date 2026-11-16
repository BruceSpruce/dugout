import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { FULL_TIME } from "~/engine/live-match";
import {
	appTRPCError,
	createTRPCRouter,
	publicProcedure,
} from "~/server/api/trpc";
import { type AppErrorData, appError, isAppError } from "~/server/app-error";
import { FORMATION_IDS, STYLE_IDS } from "~/server/game/lineup";
import {
	claimFinish,
	insertLiveRow,
	loadLiveRow,
	loadStartInput,
	loadTotalRounds,
	loadViewContext,
	lockLiveRow,
	lockLiveRowAged,
	updateLiveProgress,
	writeRoundFinish,
} from "~/server/game/load-match";
import {
	advanceMatch,
	applyChange,
	exitMatch,
	finishRound,
	isAbandoned,
	type LiveMatchRow,
	matchView,
	startRound,
} from "~/server/game/match-flow";

const MAX_INT = 2147483647;
const id = z.number().int().positive().max(MAX_INT);
const gameId = id;

const changeInput = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("sub"), out: id, in: id }),
	z.object({
		kind: z.literal("tactic"),
		formation: z.enum(FORMATION_IDS),
		style: z.enum(STYLE_IDS),
	}),
]);

const bad = (error: AppErrorData) => appTRPCError("BAD_REQUEST", error);
const gameNotFound = () => appTRPCError("NOT_FOUND", appError("gameNotFound"));
const noLiveMatch = () => bad(appError("matchNotLive"));

type Ctx = { db: Parameters<typeof loadViewContext>[0] };

async function viewOf(ctx: Ctx, row: LiveMatchRow) {
	const context = await loadViewContext(ctx.db, row.gameId);
	if (!context) {
		throw gameNotFound();
	}
	return matchView(row, context.clubs, context.results);
}

type Tx = Parameters<Parameters<Ctx["db"]["transaction"]>[0]>[0];

/**
 * The end of the round inside a transaction, shared by finish, exit and settle: conditional
 * takeover of the live row at minute 90, then results, player states and the next round (or
 * round 1 of the next season after the last round).
 */
async function finishInTx(tx: Tx, gameId: number) {
	const row = await claimFinish(tx, gameId);
	if (!row) {
		throw bad(appError("noMatchToFinish"));
	}
	const totalRounds = await loadTotalRounds(tx, gameId);
	if (!totalRounds) {
		throw gameNotFound();
	}
	const finish = finishRound(row, totalRounds);
	if (!finish.ok) throw bad(finish.error);
	try {
		await writeRoundFinish(tx, gameId, finish);
	} catch (e) {
		if (isAppError(e, "roundMoved")) throw bad(e.toData());
		throw e;
	}
	return {
		round: row.round,
		nextRound: finish.next.round,
		seasonEnded: finish.next.seasonEnded,
		results: finish.results.length,
		states: finish.states.length,
	};
}

/** Exit inside a transaction on a locked live row: AI takeover, clock to 90, end of the round. */
async function exitInTx(tx: Tx, gameId: number, locked: LiveMatchRow) {
	const next = exitMatch(locked);
	if (!next.ok) throw bad(next.error);
	await updateLiveProgress(tx, gameId, {
		minute: next.minute,
		changes: next.changes,
	});
	return finishInTx(tx, gameId);
}

export const matchRouter = createTRPCRouter({
	/** Starts the round (background matches are played now); the live match begins at minute 0. */
	start: publicProcedure
		.input(z.object({ gameId }))
		.mutation(async ({ ctx, input }) => {
			const data = await loadStartInput(ctx.db, input.gameId);
			if (!data) {
				throw gameNotFound();
			}
			const started = startRound({
				...data,
				seed: Math.floor(Math.random() * 2 ** 31),
			});
			if (!started.ok) throw bad(started.error);
			if (!(await insertLiveRow(ctx.db, started.row))) {
				throw bad(appError("matchInProgress"));
			}
			return viewOf(ctx, started.row);
		}),

	/** The live match at the stored minute; null when no match is live. Pure read. */
	view: publicProcedure
		.input(z.object({ gameId }))
		.query(async ({ ctx, input }) => {
			const row = await loadLiveRow(ctx.db, input.gameId);
			if (row?.status !== "live") return null;
			return viewOf(ctx, row);
		}),

	/** Moves the clock forward only (max 90); adds AI subs for the user's unreplaced injured players. */
	advance: publicProcedure
		.input(
			z.object({ gameId, toMinute: z.number().int().min(0).max(FULL_TIME) }),
		)
		.mutation(async ({ ctx, input }) => {
			const row = await ctx.db.transaction(async (tx) => {
				const locked = await lockLiveRow(tx, input.gameId);
				if (!locked) throw noLiveMatch();
				const next = advanceMatch(locked, input.toMinute);
				if (!next.ok) throw bad(next.error);
				if (
					next.minute !== locked.minute ||
					next.changes.length !== locked.changes.length
				) {
					await updateLiveProgress(tx, input.gameId, {
						minute: next.minute,
						changes: next.changes,
					});
				}
				return { ...locked, minute: next.minute, changes: next.changes };
			});
			return viewOf(ctx, row);
		}),

	/** The user's substitution or tactic change at the current server minute. */
	change: publicProcedure
		.input(z.object({ gameId, change: changeInput }))
		.mutation(async ({ ctx, input }) => {
			const row = await ctx.db.transaction(async (tx) => {
				const locked = await lockLiveRow(tx, input.gameId);
				if (!locked) throw noLiveMatch();
				const next = applyChange(locked, input.change);
				if (!next.ok) throw bad(next.error);
				await updateLiveProgress(tx, input.gameId, { changes: next.changes });
				return { ...locked, changes: next.changes };
			});
			return viewOf(ctx, row);
		}),

	/**
	 * Ends the round in one transaction: conditional takeover of the live row at minute 90, then
	 * results, player states and the next round (round 1 of the next season after the last one).
	 * A second finish is BAD_REQUEST.
	 */
	finish: publicProcedure
		.input(z.object({ gameId }))
		.mutation(async ({ ctx, input }) => {
			return ctx.db.transaction((tx) => finishInTx(tx, input.gameId));
		}),

	/**
	 * The user leaves the live match: the AI coaches the user's side from the current minute, the
	 * match is played to 90 and the round is written, all in one transaction. Returns what finish
	 * returns; no live match is BAD_REQUEST.
	 */
	exit: publicProcedure
		.input(z.object({ gameId }))
		.mutation(async ({ ctx, input }) => {
			return ctx.db.transaction(async (tx) => {
				const locked = await lockLiveRow(tx, input.gameId);
				if (!locked) throw noLiveMatch();
				return exitInTx(tx, input.gameId, locked);
			});
		}),

	/**
	 * Plays out an abandoned live match (no update for ABANDON_AFTER_MINUTES by the database
	 * clock) the same way as exit. Never throws for no row, a fresh match or a round that moved:
	 * it runs while game pages render.
	 */
	settle: publicProcedure
		.input(z.object({ gameId }))
		.mutation(async ({ ctx, input }) => {
			try {
				return await ctx.db.transaction(async (tx) => {
					const aged = await lockLiveRowAged(tx, input.gameId);
					if (!aged || !isAbandoned(aged.updatedAt, aged.dbNow)) {
						return { settled: false };
					}
					await exitInTx(tx, input.gameId, aged.row);
					return { settled: true };
				});
			} catch (e) {
				// Called while rendering the game pages: never let a failed settle break them.
				if (!(e instanceof TRPCError && isAppError(e.cause, "roundMoved"))) {
					console.error("match.settle failed", input.gameId, e);
				}
				return { settled: false };
			}
		}),
});
