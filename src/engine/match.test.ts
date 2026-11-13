import { describe, expect, it } from "vitest";
import {
	expectedGoals,
	MATCH_MODEL,
	MAX_GOALS,
	scoreProbabilities,
	simulateMatch,
} from "./match";
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

const sum = (grid: number[][]) =>
	grid.reduce((s, row) => s + row.reduce((a, b) => a + b, 0), 0);

describe("scoreProbabilities", () => {
	it("sums to 1 and has no negative cells, also for extreme lambdas with rho < 0", () => {
		for (const [h, a, rho] of [
			[1.5, 1.2, -0.1],
			[3.5, 0.3, -0.2],
			[0.3, 3.5, -0.2],
			[1.5, 1.2, 0],
		] as const) {
			const grid = scoreProbabilities(h, a, rho);
			expect(grid).toHaveLength(MAX_GOALS + 1);
			expect(Math.abs(sum(grid) - 1)).toBeLessThan(1e-9);
			for (const row of grid) {
				expect(row).toHaveLength(MAX_GOALS + 1);
				for (const p of row) expect(p).toBeGreaterThanOrEqual(0);
			}
		}
	});

	it("with rho = 0 each cell is the product of Poisson pmfs over the grid mass", () => {
		const [lh, la] = [1.7, 1.1];
		const grid = scoreProbabilities(lh, la, 0);
		const pmf = (l: number) => {
			const out: number[] = [];
			let p = Math.exp(-l);
			for (let k = 0; k <= MAX_GOALS; k++) {
				out.push(p);
				p = (p * l) / (k + 1);
			}
			return out;
		};
		const ph = pmf(lh);
		const pa = pmf(la);
		const mass = ph.reduce((s, x) => s + x, 0) * pa.reduce((s, x) => s + x, 0);
		for (let x = 0; x <= MAX_GOALS; x++) {
			for (let y = 0; y <= MAX_GOALS; y++) {
				const expected = ((ph[x] ?? 0) * (pa[y] ?? 0)) / mass;
				expect(Math.abs((grid[x]?.[y] ?? 0) - expected)).toBeLessThan(1e-9);
			}
		}
	});

	it("rho < 0 raises 0-0, 1-1 and draws and lowers 1-0 and 0-1", () => {
		const base = scoreProbabilities(1.6, 1.2, 0);
		const dc = scoreProbabilities(1.6, 1.2, -0.1);
		const cell = (g: number[][], x: number, y: number) => g[x]?.[y] ?? 0;
		expect(cell(dc, 0, 0)).toBeGreaterThan(cell(base, 0, 0));
		expect(cell(dc, 1, 1)).toBeGreaterThan(cell(base, 1, 1));
		expect(cell(dc, 1, 0)).toBeLessThan(cell(base, 1, 0));
		expect(cell(dc, 0, 1)).toBeLessThan(cell(base, 0, 1));
		const draw = (g: number[][]) =>
			g.reduce((s, row, i) => s + (row[i] ?? 0), 0);
		expect(draw(dc)).toBeGreaterThan(draw(base));
	});

	it("simulateMatch frequencies over 200000 draws match the matrix", () => {
		const model = { ...MATCH_MODEL, drawRho: -0.1 };
		const { home, away } = expectedGoals(72, 68, model);
		const grid = scoreProbabilities(home, away, model.drawRho);
		const rng = createRng(31337);
		const n = 200_000;
		const counts = new Map<string, number>();
		for (let i = 0; i < n; i++) {
			const r = simulateMatch(72, 68, rng, model);
			const key = `${r.homeGoals}-${r.awayGoals}`;
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		for (const [x, y] of [
			[0, 0],
			[1, 0],
			[0, 1],
			[1, 1],
			[2, 1],
		] as const) {
			const freq = (counts.get(`${x}-${y}`) ?? 0) / n;
			expect(Math.abs(freq - (grid[x]?.[y] ?? 0))).toBeLessThan(0.003);
		}
	});

	it("same seed gives the same sequence of results", () => {
		const model = { ...MATCH_MODEL, drawRho: -0.1 };
		const run = (seed: number) => {
			const rng = createRng(seed);
			return Array.from({ length: 200 }, () =>
				simulateMatch(75, 68, rng, model),
			);
		};
		expect(run(5)).toEqual(run(5));
		expect(run(5)).not.toEqual(run(6));
	});
});
