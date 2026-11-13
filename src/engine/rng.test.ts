import { describe, expect, it } from "vitest";
import { createRng, poisson } from "./rng";

describe("createRng", () => {
	it("gives the same sequence for the same seed", () => {
		const a = createRng(42);
		const b = createRng(42);
		const seqA = Array.from({ length: 20 }, () => a());
		const seqB = Array.from({ length: 20 }, () => b());
		expect(seqA).toEqual(seqB);
	});

	it("gives different sequences for different seeds", () => {
		const a = createRng(1);
		const b = createRng(2);
		expect(a()).not.toBe(b());
	});

	it("returns values in [0, 1)", () => {
		const rng = createRng(7);
		for (let i = 0; i < 10_000; i++) {
			const v = rng();
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThan(1);
		}
	});
});

describe("poisson", () => {
	it("returns 0 for lambda <= 0", () => {
		const rng = createRng(1);
		expect(poisson(rng, 0)).toBe(0);
		expect(poisson(rng, -1.5)).toBe(0);
	});

	it.each([0.8, 1.5, 3])(
		"mean of 100000 draws is within 2%% of lambda %s",
		(lambda) => {
			const rng = createRng(12345);
			const n = 100_000;
			let sum = 0;
			for (let i = 0; i < n; i++) sum += poisson(rng, lambda);
			expect(Math.abs(sum / n - lambda)).toBeLessThan(lambda * 0.02);
		},
	);
});
