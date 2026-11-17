import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";

import { APP_ERROR_CODES, AppError, appError } from "~/server/app-error";
import en from "../../messages/en.json";
import pl from "../../messages/pl.json";
import { appErrorOf, errorText } from "./error-text";

const tPl = createTranslator({ locale: "pl", messages: pl });
const tEn = createTranslator({ locale: "en", messages: en });

const injured = (n: number) =>
	appError("playerUnavailable", {
		where: "starters",
		name: "Kowalski",
		reason: appError("unavailableInjury", { n }),
	});

describe("errorText", () => {
	it("translates a code with params", () => {
		expect(errorText(tPl, appError("subsLimit", { max: 5 }))).toBe(
			"Wykorzystano limit 5 zmian.",
		);
		expect(errorText(tEn, appError("subsLimit", { max: 5 }))).toBe(
			"The limit of 5 substitutions has been used.",
		);
		expect(errorText(tEn, appError("matchInProgress"))).toBe(
			"A match is already in progress.",
		);
	});

	it("translates a nested code (reason) first", () => {
		expect(errorText(tPl, injured(2))).toBe(
			"Niedostępny zawodnik w składzie: Kowalski — kontuzja, jeszcze 2 mecze",
		);
		expect(
			errorText(
				tPl,
				appError("savedLineupInvalid", { reason: appError("benchDuplicate") }),
			),
		).toBe(
			"Zapisany skład: Ten sam zawodnik występuje na ławce więcej niż raz.",
		);
		expect(
			errorText(
				tEn,
				appError("playerUnavailable", {
					where: "bench",
					name: "Smith",
					reason: appError("unavailableSuspension", { n: 1 }),
				}),
			),
		).toBe("Unavailable player on the bench: Smith — suspended, 1 more match");
	});

	it("Polish plural of matches: 1, 2, 4, 5, 12, 22, 25", () => {
		const reason = (n: number) =>
			errorText(tPl, appError("unavailableInjury", { n }));
		expect([1, 2, 4, 5, 12, 22, 25].map(reason)).toEqual([
			"kontuzja, jeszcze 1 mecz",
			"kontuzja, jeszcze 2 mecze",
			"kontuzja, jeszcze 4 mecze",
			"kontuzja, jeszcze 5 meczów",
			"kontuzja, jeszcze 12 meczów",
			"kontuzja, jeszcze 22 mecze",
			"kontuzja, jeszcze 25 meczów",
		]);
		expect(tPl("lineup.absence.suspension", { n: 5 })).toBe("pauza 5 meczów");
	});

	it("English plural of matches: 1, 2", () => {
		expect(errorText(tEn, appError("unavailableInjury", { n: 1 }))).toBe(
			"injured, 1 more match",
		);
		expect(errorText(tEn, appError("unavailableInjury", { n: 2 }))).toBe(
			"injured, 2 more matches",
		);
		expect(tEn("lineup.absence.injury", { n: 2 })).toBe("injury 2 matches");
	});

	it("reads AppError, a TRPCClientError-like data.appError and a TRPCError-like cause", () => {
		expect(errorText(tEn, new AppError("roundMoved"))).toBe(
			"The round has already been saved (the game is in another round).",
		);
		const clientError = Object.assign(new Error("subsLimit"), {
			data: {
				code: "BAD_REQUEST",
				appError: appError("subsLimit", { max: 3 }),
			},
		});
		expect(errorText(tPl, clientError)).toBe("Wykorzystano limit 3 zmian.");
		const serverError = new Error("seasonNotLoaded", {
			cause: new AppError("seasonNotLoaded"),
		});
		expect(appErrorOf(serverError)).toEqual({ code: "seasonNotLoaded" });
		expect(errorText(tPl, serverError)).toBe(
			"Sezon nie jest załadowany — uruchom npm run open:load",
		);
	});

	it("unknown errors fall back to errors.unknown or the given fallback", () => {
		expect(errorText(tPl, new Error("Failed to fetch"))).toBe(
			"Coś poszło nie tak.",
		);
		expect(errorText(tEn, null)).toBe("Something went wrong.");
		expect(errorText(tEn, { code: "noSuchCode" })).toBe(
			"Something went wrong.",
		);
		// An Error with a `code` (e.g. TRPCError "NOT_FOUND") is not AppErrorData.
		expect(
			errorText(tEn, Object.assign(new Error("x"), { code: "gameNotFound" })),
		).toBe("Something went wrong.");
		expect(errorText(tEn, new Error("x"), "startFailed")).toBe(
			"Could not start the match.",
		);
		expect(errorText(tPl, { data: { appError: null } }, "changeFailed")).toBe(
			"Nie udało się wprowadzić zmiany.",
		);
	});
});

describe("APP_ERROR_CODES", () => {
	it("has an errors.<code> message in pl and en for every code", () => {
		for (const code of APP_ERROR_CODES) {
			expect(tPl.has(`errors.${code}`), `pl ${code}`).toBe(true);
			expect(tEn.has(`errors.${code}`), `en ${code}`).toBe(true);
		}
	});
});
