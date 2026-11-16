// Language-free errors: the engine, server/game and the routers return or throw a code with
// params, the UI translates it (messages/*.json, errors.<code>; src/i18n/error-text.ts).
// No framework imports: client components import this file too.

import type { LiveChangeErrorCode } from "~/engine/live-match";

/** Every error code a player can see; each one has an `errors.<code>` message. */
export type AppErrorCode =
	| LiveChangeErrorCode
	// routers
	| "gameNotFound"
	| "seasonNotLoaded"
	| "seasonNotCompleted"
	| "clubNotInSeason"
	| "gameCreateFailed"
	| "noMatchToFinish"
	// match flow
	| "matchInProgress"
	| "matchNotLive"
	| "matchStillRunning"
	| "noOwnFixture"
	| "savedLineupInvalid"
	| "roundMoved"
	// lineup
	| "unknownStyle"
	| "lineupSize"
	| "starterDuplicate"
	| "starterNotInSquad"
	| "benchSize"
	| "benchDuplicate"
	| "benchNotInSquad"
	| "starterOnBench"
	| "playerUnavailable"
	| "unavailableInjury"
	| "unavailableSuspension";

/** ICU params; a nested AppErrorData is translated first and passed as text. */
export type AppErrorParams = Record<string, string | number | AppErrorData>;

/** Plain, superjson-serialisable error data (return values, tRPC `data.appError`). */
export type AppErrorData = { code: AppErrorCode; params?: AppErrorParams };

/** Builds AppErrorData; `params` is left out when not given. */
export function appError(
	code: AppErrorCode,
	params?: AppErrorParams,
): AppErrorData {
	return params === undefined ? { code } : { code, params };
}

/** The throwable form (TRPCError.cause must be an Error); message = code. */
export class AppError extends Error {
	readonly code: AppErrorCode;
	readonly params?: AppErrorParams;

	constructor(code: AppErrorCode, params?: AppErrorParams) {
		super(code);
		this.name = "AppError";
		this.code = code;
		if (params !== undefined) this.params = params;
	}

	static from(data: AppErrorData): AppError {
		return new AppError(data.code, data.params);
	}

	toData(): AppErrorData {
		return appError(this.code, this.params);
	}
}

/** True for an AppError with the given code. */
export function isAppError(e: unknown, code: AppErrorCode): e is AppError {
	return e instanceof AppError && e.code === code;
}
