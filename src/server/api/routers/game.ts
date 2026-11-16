import { TRPCError } from "@trpc/server";
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { bestElevenFor, teamRatings } from "~/engine/tactics";
import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";
import { club, game, gameLineup } from "~/server/db/schema";
import {
	aiProposal,
	FORMATION_IDS,
	loadClubSquad,
	STYLE_IDS,
	sortSquad,
	squadForRound,
	validateAvailability,
	validateLineup,
} from "~/server/game/lineup";
import {
	latestSeasonId,
	loadRoundScreenInput,
	loadSeasonClubs,
} from "~/server/game/load-round-screen";
import {
	loadCompletedResults,
	loadSeasonGame,
	loadSeasonResults,
} from "~/server/game/load-season";
import { buildRoundScreen } from "~/server/game/round-screen";
import {
	completedSeasons,
	gameHistory,
	seasonSummary,
} from "~/server/game/season-summary";

const GAME_NOT_FOUND = "Nie ma takiej gry";
const SEASON_NOT_COMPLETED = "Ten sezon się jeszcze nie zakończył";
const MAX_INT = 2147483647;
const id = z.number().int().positive().max(MAX_INT);
const gameId = id;
const formationInput = z.enum(FORMATION_IDS);
const styleInput = z.enum(STYLE_IDS);
const bench = z.array(id).max(9);

const SEASON_NOT_LOADED =
	"Sezon nie jest załadowany — uruchom npm run import:season";

export const gameRouter = createTRPCRouter({
	clubs: publicProcedure.query(async ({ ctx }) => {
		const seasonId = await latestSeasonId(ctx.db);
		if (seasonId === null) {
			throw new TRPCError({ code: "NOT_FOUND", message: SEASON_NOT_LOADED });
		}
		return loadSeasonClubs(ctx.db, seasonId);
	}),

	create: publicProcedure
		.input(z.object({ clubId: id }))
		.mutation(async ({ ctx, input }) => {
			const seasonId = await latestSeasonId(ctx.db);
			if (seasonId === null) {
				throw new TRPCError({ code: "NOT_FOUND", message: SEASON_NOT_LOADED });
			}
			const clubs = await loadSeasonClubs(ctx.db, seasonId);
			if (!clubs.some((c) => c.clubId === input.clubId)) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Ten klub nie gra w załadowanym sezonie",
				});
			}
			const [created] = await ctx.db
				.insert(game)
				.values({ competitionSeasonId: seasonId, clubId: input.clubId })
				.returning({ id: game.id });
			if (!created) {
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: "Nie udało się utworzyć gry",
				});
			}
			return { gameId: created.id };
		}),

	list: publicProcedure.query(async ({ ctx }) => {
		const rows = await ctx.db
			.select({
				gameId: game.id,
				clubName: club.name,
				seasonNo: game.seasonNo,
				currentRound: game.currentRound,
				createdAt: game.createdAt,
			})
			.from(game)
			.innerJoin(club, eq(club.id, game.clubId))
			.orderBy(desc(game.createdAt), desc(game.id));
		return rows;
	}),

	roundScreen: publicProcedure
		.input(z.object({ gameId }))
		.query(async ({ ctx, input }) => {
			const data = await loadRoundScreenInput(ctx.db, input.gameId);
			if (!data) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Nie ma takiej gry",
				});
			}
			return buildRoundScreen(data);
		}),

	season: publicProcedure
		.input(z.object({ gameId, seasonNo: id }))
		.query(async ({ ctx, input }) => {
			const g = await loadSeasonGame(ctx.db, input.gameId);
			if (!g) {
				throw new TRPCError({ code: "NOT_FOUND", message: GAME_NOT_FOUND });
			}
			// Only completed seasons: the current one is still running, later ones do not exist.
			if (input.seasonNo >= g.seasonNo) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: SEASON_NOT_COMPLETED,
				});
			}
			const results = await loadSeasonResults(
				ctx.db,
				input.gameId,
				input.seasonNo,
			);
			return seasonSummary({
				seasonNo: input.seasonNo,
				clubs: g.clubs,
				results,
				userClubId: g.clubId,
			});
		}),

	history: publicProcedure
		.input(z.object({ gameId }))
		.query(async ({ ctx, input }) => {
			const g = await loadSeasonGame(ctx.db, input.gameId);
			if (!g) {
				throw new TRPCError({ code: "NOT_FOUND", message: GAME_NOT_FOUND });
			}
			const rows = await loadCompletedResults(ctx.db, input.gameId, g.seasonNo);
			return gameHistory({
				clubs: g.clubs,
				seasons: completedSeasons(rows, g.seasonNo),
				userClubId: g.clubId,
			});
		}),

	lineup: publicProcedure
		.input(z.object({ gameId }))
		.query(async ({ ctx, input }) => {
			const data = await loadClubSquad(ctx.db, input.gameId);
			if (!data) {
				throw new TRPCError({ code: "NOT_FOUND", message: GAME_NOT_FOUND });
			}
			const [saved] = await ctx.db
				.select({
					formation: gameLineup.formation,
					style: gameLineup.style,
					starters: gameLineup.starters,
					bench: gameLineup.bench,
				})
				.from(gameLineup)
				.where(eq(gameLineup.gameId, input.gameId));
			const round = squadForRound(data.squad, data.states);
			const order = new Map(
				sortSquad(data.squad).map((p, i) => [p.playerId, i]),
			);
			return {
				// Base attributes plus `status` (kickoff fitness, injury / ban matches, availability).
				squad: [...round.withStatus].sort(
					(a, b) => (order.get(a.playerId) ?? 0) - (order.get(b.playerId) ?? 0),
				),
				saved: saved ?? null,
				proposal: aiProposal(round.available, "4-4-2"),
			};
		}),

	aiLineup: publicProcedure
		.input(z.object({ gameId, formation: formationInput }))
		.query(async ({ ctx, input }) => {
			const data = await loadClubSquad(ctx.db, input.gameId);
			if (!data) {
				throw new TRPCError({ code: "NOT_FOUND", message: GAME_NOT_FOUND });
			}
			return aiProposal(
				squadForRound(data.squad, data.states).available,
				input.formation,
			);
		}),

	ratings: publicProcedure
		.input(
			z.object({
				gameId,
				formation: formationInput,
				style: styleInput,
				starters: z.array(id).length(11),
			}),
		)
		.query(async ({ ctx, input }) => {
			const data = await loadClubSquad(ctx.db, input.gameId);
			if (!data) {
				throw new TRPCError({ code: "NOT_FOUND", message: GAME_NOT_FOUND });
			}
			const effective = squadForRound(data.squad, data.states).effective;
			const byId = new Map(effective.map((p) => [p.playerId, p]));
			const slots = bestElevenFor([], input.formation).map((slot, i) => ({
				role: slot.role,
				player: byId.get(input.starters[i] ?? -1) ?? null,
			}));
			const r = teamRatings(slots, {
				formation: input.formation,
				style: input.style,
			});
			const round1 = (x: number) => Math.round(x * 10) / 10;
			return { attack: round1(r.attack), defense: round1(r.defense) };
		}),

	saveLineup: publicProcedure
		.input(
			z.object({
				gameId,
				formation: formationInput,
				style: styleInput,
				starters: z.array(id).max(11),
				bench,
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const data = await loadClubSquad(ctx.db, input.gameId);
			if (!data) {
				throw new TRPCError({ code: "NOT_FOUND", message: GAME_NOT_FOUND });
			}
			const checked = validateLineup(
				input,
				new Set(data.squad.map((p) => p.playerId)),
			);
			if (!checked.ok) {
				throw new TRPCError({ code: "BAD_REQUEST", message: checked.error });
			}
			const available = validateAvailability(input, data.squad, data.states);
			if (!available.ok) {
				throw new TRPCError({ code: "BAD_REQUEST", message: available.error });
			}
			const values = {
				formation: input.formation,
				style: input.style,
				starters: input.starters,
				bench: input.bench,
			};
			await ctx.db
				.insert(gameLineup)
				.values({ gameId: input.gameId, ...values })
				.onConflictDoUpdate({
					target: gameLineup.gameId,
					set: { ...values, updatedAt: sql`now()` },
				});
			return { ok: true as const };
		}),
});
