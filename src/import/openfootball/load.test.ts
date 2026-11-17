import { describe, expect, it } from "vitest";

import { clubKeyClashes, openLoadMode } from "./load";

describe("openLoadMode", () => {
	it("matched when the season's fixtures all come from the API", () => {
		expect(
			openLoadMode({ seasonExists: true, fixtures: 380, withApiId: 380 }),
		).toBe("matched");
	});
	it("created when the season is missing", () => {
		expect(
			openLoadMode({ seasonExists: false, fixtures: 0, withApiId: 0 }),
		).toBe("created");
	});
	it("created for an openfootball-only season", () => {
		expect(
			openLoadMode({ seasonExists: true, fixtures: 306, withApiId: 0 }),
		).toBe("created");
	});
	it("throws on mixed sources", () => {
		expect(() =>
			openLoadMode({ seasonExists: true, fixtures: 380, withApiId: 10 }),
		).toThrow(/mixed/);
	});
});

describe("clubKeyClashes", () => {
	it("reports club keys that play in another league, deduplicated and sorted", () => {
		const rows = [
			{ sourceKey: "of:b", leagueApiId: 40 },
			{ sourceKey: "of:a", leagueApiId: 40 },
			{ sourceKey: "of:a", leagueApiId: 40 },
			{ sourceKey: "of:c", leagueApiId: 39 },
			{ sourceKey: null, leagueApiId: 40 },
		];
		expect(clubKeyClashes(rows, 39)).toEqual(["of:a", "of:b"]);
	});
	it("is empty when every key is only in this league", () => {
		expect(
			clubKeyClashes([{ sourceKey: "of:c", leagueApiId: 39 }], 39),
		).toEqual([]);
	});
});
