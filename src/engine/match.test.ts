import { describe, expect, it } from "vitest";
import { expectedGoals, MATCH_MODEL, simulateMatch } from "./match";
import { createRng } from "./rng";

describe("expectedGoals", () => {
	it("gives the home side a higher lambda at equal strength", () => {
		const { home, away } = expectedGoals(70, 70);
		expect(home).toBeGreaterThan(away);
	});

	it("a bigger gap raises home lambda and lowers away lambda", () => {
		const small = expectedGoals(72, 70);
		const big = expectedGoals(80, 70);
		expect(big.home).toBeGreaterThan(small.home);
		expect(big.away).toBeLessThan(small.away);
	});

	it("uses MATCH_MODEL by default and accepts an override", () => {
		expect(expectedGoals(70, 70)).toEqual(expectedGoals(70, 70, MATCH_MODEL));
		const flat = expectedGoals(70, 70, { ...MATCH_MODEL, homeAdvantage: 0 });
		expect(flat.home).toBeCloseTo(flat.away, 12);
	});
});

describe("simulateMatch", () => {
	it("is deterministic for the same seed", () => {
		const a = simulateMatch(75, 68, createRng(99));
		const b = simulateMatch(75, 68, createRng(99));
		expect(a).toEqual(b);
	});

	it("mean total goals over 100000 matches is within 2% of the sum of lambdas", () => {
		const rng = createRng(2024);
		const n = 100_000;
		let goals = 0;
		for (let i = 0; i < n; i++) {
			const r = simulateMatch(74, 66, rng);
			goals += r.homeGoals + r.awayGoals;
		}
		const { home, away } = expectedGoals(74, 66);
		const expected = home + away;
		expect(Math.abs(goals / n - expected)).toBeLessThan(expected * 0.02);
	});
});
