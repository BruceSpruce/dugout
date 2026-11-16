import { describe, expect, it } from "vitest";

import { isLocale, resolveLocale } from "./locale";

describe("resolveLocale", () => {
	it("uses a valid cookie over the header", () => {
		expect(resolveLocale("pl", "en-US")).toBe("pl");
		expect(resolveLocale("en", "pl-PL,pl;q=0.9")).toBe("en");
	});

	it("ignores an invalid cookie", () => {
		expect(resolveLocale("xx", "pl-PL,pl;q=0.9")).toBe("pl");
		expect(resolveLocale("garbage", undefined)).toBe("en");
		expect(resolveLocale("PL", "de")).toBe("en");
	});

	it("reads Accept-Language", () => {
		expect(resolveLocale(undefined, "pl-PL,pl;q=0.9")).toBe("pl");
		expect(resolveLocale(undefined, "pl")).toBe("pl");
		expect(resolveLocale(undefined, "en-US")).toBe("en");
		expect(resolveLocale(undefined, "de")).toBe("en");
	});

	it("honours q-values", () => {
		expect(resolveLocale(undefined, "en;q=0.5,pl;q=0.9")).toBe("pl");
		expect(resolveLocale(undefined, "pl;q=0.5,en;q=0.9")).toBe("en");
		expect(resolveLocale(undefined, "pl;q=0,de")).toBe("en");
	});

	it("falls back to English for an empty or missing header", () => {
		expect(resolveLocale()).toBe("en");
		expect(resolveLocale(undefined, "")).toBe("en");
		expect(resolveLocale("", "")).toBe("en");
		expect(resolveLocale(null, null)).toBe("en");
	});
});

describe("isLocale", () => {
	it("accepts only supported locales", () => {
		expect(isLocale("pl")).toBe(true);
		expect(isLocale("en")).toBe(true);
		expect(isLocale("de")).toBe(false);
		expect(isLocale(undefined)).toBe(false);
	});
});
