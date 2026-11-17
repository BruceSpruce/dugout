import type { OpenFixture } from "./normalize";

export type ExistingFixture = {
	homeClubId: number;
	awayClubId: number;
	kickoffAt: Date;
};

const DAY = 86_400_000;
const dayOf = (d: Date) => Math.floor(d.getTime() / DAY);

/**
 * Maps openfootball club keys to existing club ids by voting over fixtures:
 * same UTC date first, +-1 day only when the date has no candidate.
 * Throws when the mapping is not a bijection or the pair sets differ.
 */
export function matchClubsByFixtures(
	open: Pick<OpenFixture, "homeKey" | "awayKey" | "kickoffAt">[],
	existing: ExistingFixture[],
): Map<string, number> {
	const byDay = new Map<number, ExistingFixture[]>();
	for (const e of existing) {
		const k = dayOf(e.kickoffAt);
		byDay.set(k, [...(byDay.get(k) ?? []), e]);
	}
	const votes = new Map<string, Map<number, number>>();
	const vote = (key: string, id: number) => {
		const m = votes.get(key) ?? new Map<number, number>();
		m.set(id, (m.get(id) ?? 0) + 1);
		votes.set(key, m);
	};
	for (const o of open) {
		const d = dayOf(o.kickoffAt);
		let cands = byDay.get(d) ?? [];
		if (cands.length === 0) {
			cands = [...(byDay.get(d - 1) ?? []), ...(byDay.get(d + 1) ?? [])];
		}
		for (const c of cands) {
			vote(o.homeKey, c.homeClubId);
			vote(o.awayKey, c.awayClubId);
		}
	}

	const keys = new Set<string>();
	for (const o of open) {
		keys.add(o.homeKey);
		keys.add(o.awayKey);
	}
	const result = new Map<string, number>();
	const problems: string[] = [];
	for (const key of keys) {
		const m = votes.get(key);
		let best: number | null = null;
		let bestN = 0;
		let tie = false;
		for (const [id, n] of m ?? []) {
			if (n > bestN) {
				best = id;
				bestN = n;
				tie = false;
			} else if (n === bestN) tie = true;
		}
		if (best === null || tie) problems.push(`${key}: no unique match`);
		else result.set(key, best);
	}
	const used = new Map<number, string>();
	for (const [key, id] of result) {
		const prev = used.get(id);
		if (prev) problems.push(`${key} and ${prev} map to the same club ${id}`);
		used.set(id, key);
	}
	const existingIds = new Set<number>();
	for (const e of existing) {
		existingIds.add(e.homeClubId);
		existingIds.add(e.awayClubId);
	}
	for (const id of existingIds) {
		if (!used.has(id)) problems.push(`existing club ${id} unmatched`);
	}
	if (problems.length === 0) {
		const want = new Set(
			existing.map((e) => `${e.homeClubId}|${e.awayClubId}`),
		);
		const got = new Set(
			open.map((o) => `${result.get(o.homeKey)}|${result.get(o.awayKey)}`),
		);
		if (want.size !== got.size || [...want].some((p) => !got.has(p))) {
			problems.push("fixture pair sets differ after mapping");
		}
	}
	if (problems.length > 0) {
		throw new Error(`club matching failed: ${problems.join("; ")}`);
	}
	return result;
}
