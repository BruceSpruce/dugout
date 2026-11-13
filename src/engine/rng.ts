// Seeded random number generator and Poisson sampling for the simulation engine.
// Pure module: no imports outside src/engine/ (runs from the CLI for calibration).

/** Returns values in [0, 1). */
export type Rng = () => number;

/** mulberry32: small, fast, deterministic PRNG. Same seed gives the same sequence. */
export function createRng(seed: number): Rng {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Poisson draw using Knuth's method. lambda <= 0 gives 0. */
export function poisson(rng: Rng, lambda: number): number {
	if (!(lambda > 0)) return 0;
	const limit = Math.exp(-lambda);
	let k = 0;
	let p = 1;
	do {
		k++;
		p *= rng();
	} while (p > limit);
	return k - 1;
}
