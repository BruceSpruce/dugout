import { TRPCError } from "@trpc/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";

import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";
import { club, game } from "~/server/db/schema";
import {
	latestSeasonId,
	loadRoundScreenInput,
	loadSeasonClubs,
} from "~/server/game/load-round-screen";
import { buildRoundScreen } from "~/server/game/round-screen";

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
		.input(z.object({ clubId: z.number().int().positive() }))
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
				currentRound: game.currentRound,
				createdAt: game.createdAt,
			})
			.from(game)
			.innerJoin(club, eq(club.id, game.clubId))
			.orderBy(desc(game.createdAt), desc(game.id));
		return rows;
	}),

	roundScreen: publicProcedure
		.input(z.object({ gameId: z.number().int().positive() }))
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
});
