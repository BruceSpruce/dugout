// One place that turns any error the UI can see into text in the player's language: a tRPC
// client error (`data.appError`), a server-side TRPCError (`cause` = AppError), an AppError or
// plain AppErrorData. Nested AppErrorData params are translated first and passed as text.

import type { createTranslator, Messages } from "next-intl";

import {
	AppError,
	type AppErrorCode,
	type AppErrorData,
} from "~/server/app-error";

/** Root translator: `useTranslations()`, `await getTranslations()` or `createTranslator`. */
export type ErrorTranslator = ReturnType<typeof createTranslator<Messages>>;

/** Keys of `errors.*`: every AppErrorCode plus UI fallbacks (unknown, startFailed, ...). */
export type ErrorKey = keyof Messages["errors"];

/** Compile-time check: every AppErrorCode has an `errors.<code>` message (en.json is the source). */
type UntranslatedCodes = Exclude<AppErrorCode, ErrorKey>;
export const ALL_ERROR_CODES_TRANSLATED: [UntranslatedCodes] extends [never]
	? true
	: UntranslatedCodes = true;

/** The typed translator seen with runtime-built keys (`errors.${code}`). */
type LooseTranslator = {
	(key: string, values?: Record<string, string | number>): string;
	has(key: string): boolean;
};

const loose = (t: ErrorTranslator) => t as unknown as LooseTranslator;

const isObject = (x: unknown): x is Record<string, unknown> =>
	typeof x === "object" && x !== null;

function isAppErrorData(x: unknown): x is AppErrorData {
	return (
		isObject(x) &&
		typeof x.code === "string" &&
		(x.params === undefined || isObject(x.params))
	);
}

/** The AppErrorData carried by an error, or null when it carries none. */
export function appErrorOf(error: unknown): AppErrorData | null {
	if (error instanceof AppError) return error.toData();
	if (!isObject(error)) return null;
	// TRPCClientError: errorFormatter puts the code into data.appError.
	if (isObject(error.data) && isAppErrorData(error.data.appError)) {
		return error.data.appError;
	}
	// Server-side TRPCError (createCaller): the AppError is the cause.
	if (error.cause instanceof AppError) return error.cause.toData();
	// Plain AppErrorData (engine / FlowResult values); never an Error such as TRPCError.
	if (!(error instanceof Error) && isAppErrorData(error)) return error;
	return null;
}

function translate(t: LooseTranslator, data: AppErrorData): string | null {
	const key = `errors.${data.code}`;
	if (!t.has(key)) return null;
	const values: Record<string, string | number> = {};
	for (const [name, value] of Object.entries(data.params ?? {})) {
		if (typeof value === "string" || typeof value === "number") {
			values[name] = value;
		} else {
			values[name] = translate(t, value) ?? t("errors.unknown");
		}
	}
	return t(key, values);
}

/**
 * Text of `error` in the translator's language; `fallback` (default `unknown`) when the error
 * carries no known code (network failure, input validation, an unexpected exception).
 */
export function errorText(
	t: ErrorTranslator,
	error: unknown,
	fallback: ErrorKey = "unknown",
): string {
	const tr = loose(t);
	const data = appErrorOf(error);
	return (data ? translate(tr, data) : null) ?? tr(`errors.${fallback}`);
}
