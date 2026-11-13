import { gameRouter } from "~/server/api/routers/game";
import {
	createCallerFactory,
	createTRPCRouter,
	publicProcedure,
} from "~/server/api/trpc";

/**
 * This is the primary router for your server.
 *
 * All routers added in /api/routers should be manually added here.
 * `health` keeps the router non-empty: tRPC's hydration helpers (src/trpc/server.ts) do not
 * type-check against an empty router record.
 */
export const appRouter = createTRPCRouter({
	game: gameRouter,
	health: publicProcedure.query(() => ({ ok: true as const })),
});

// export type definition of API
export type AppRouter = typeof appRouter;

/**
 * Create a server-side caller for the tRPC API.
 * @example
 * const trpc = createCaller(createContext);
 * const res = await trpc.health();
 */
export const createCaller = createCallerFactory(appRouter);
