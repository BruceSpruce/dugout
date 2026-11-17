import { describe, expect, it } from "vitest";

import { openLoadMode } from "./load";

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
