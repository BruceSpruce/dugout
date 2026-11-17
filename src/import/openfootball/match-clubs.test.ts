import { describe, expect, it } from "vitest";

import { matchClubsByFixtures } from "./match-clubs";

const NAMES = ["a", "b", "c", "d"];
const day = (n: number) => new Date(Date.UTC(2024, 7, 1 + n, 15));

function schedule() {
	const out: { h: string; a: string; t: Date }[] = [];
	let i = 0;
	for (const h of NAMES) {
		for (const a of NAMES) {
			if (h !== a) out.push({ h, a, t: day(i++) });
		}
	}
	return out;
}
const idOf = (k: string) => (NAMES.indexOf(k) + 1) * 100;
const open = () =>
	schedule().map((s) => ({
		homeKey: `of:${s.h}`,
		awayKey: `of:${s.a}`,
		kickoffAt: s.t,
	}));
const existing = () =>
	schedule().map((s) => ({
		homeClubId: idOf(s.h),
		awayClubId: idOf(s.a),
		kickoffAt: s.t,
	}));

describe("matchClubsByFixtures", () => {
	it("maps all clubs", () => {
		const m = matchClubsByFixtures(open(), existing());
		expect(m.size).toBe(4);
		expect(m.get("of:c")).toBe(300);
	});

	it("tolerates one match shifted by a day", () => {
		const e = existing();
		const s = e[5];
		if (!s) throw new Error("empty");
		s.kickoffAt = new Date(s.kickoffAt.getTime() + 86_400_000);
		const m = matchClubsByFixtures(open(), e);
		expect(m.size).toBe(4);
		expect(m.get("of:d")).toBe(400);
	});

	it("falls back to +-1 day when a date has no candidate", () => {
		const pick = <T>(xs: T[]) => [xs[0], xs[4]] as T[];
		const o = pick(open());
		const e = pick(existing());
		for (const x of e)
			x.kickoffAt = new Date(x.kickoffAt.getTime() + 86_400_000);
		const m = matchClubsByFixtures(o, e);
		expect(m.get("of:b")).toBe(200);
		expect(m.get("of:c")).toBe(300);
		for (const x of e)
			x.kickoffAt = new Date(x.kickoffAt.getTime() + 86_400_000 * 2);
		expect(() => matchClubsByFixtures(o, e)).toThrow();
	});

	it("throws on non-bijection", () => {
		const e = existing().map((x) => ({
			...x,
			homeClubId: x.homeClubId === 400 ? 300 : x.homeClubId,
			awayClubId: x.awayClubId === 400 ? 300 : x.awayClubId,
		}));
		expect(() => matchClubsByFixtures(open(), e)).toThrow(
			/club matching failed/,
		);
	});

	it("throws when pair sets differ", () => {
		const e = existing();
		e.pop();
		expect(() => matchClubsByFixtures(open(), e)).toThrow();
	});
});
