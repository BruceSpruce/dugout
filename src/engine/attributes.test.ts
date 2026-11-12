import { describe, expect, it } from "vitest";
import {
	type Counters,
	computeAttributes,
	type PlayerInput,
	type Position,
} from "./attributes";

const ZERO: Counters = {
	goals: 0,
	penaltyScored: 0,
	shotsTotal: 0,
	shotsOn: 0,
	assists: 0,
	passesKey: 0,
	passesTotal: 0,
	dribblesSuccess: 0,
	tackles: 0,
	interceptions: 0,
	blocks: 0,
	duels: 0,
	duelsWon: 0,
	dribblesPast: 0,
	saves: 0,
	goalsConceded: 0,
	penaltySaved: 0,
	foulsCommitted: 0,
	yellowCards: 0,
	yellowRedCards: 0,
	redCards: 0,
};

let nextId = 1;

/** Synthetic player; counters are given per 90 and scaled to the minutes played. */
function player(
	position: Position,
	minutes: number,
	per90: Partial<Counters> = {},
	over: Partial<PlayerInput> = {},
): PlayerInput {
	const counters = { ...ZERO };
	for (const [k, v] of Object.entries(per90) as [keyof Counters, number][]) {
		counters[k] = (v * minutes) / 90;
	}
	const id = nextId++;
	return {
		playerId: id,
		name: `P${id}`,
		clubId: 1,
		position,
		minutes,
		ratingMinutes: minutes > 0 ? 6.5 : null,
		clubPlayedMinutes: 3420,
		counters,
		...over,
	};
}

/** 8 playing players per position group with spread-out stats. */
function league(): PlayerInput[] {
	const out: PlayerInput[] = [];
	for (const pos of [
		"Goalkeeper",
		"Defender",
		"Midfielder",
		"Attacker",
	] as const) {
		for (let i = 0; i < 8; i++) {
			const f = 1 + i * 0.25;
			out.push(
				player(
					pos,
					1500 + i * 200,
					{
						goals: 0.1 * f,
						shotsOn: 0.3 * f,
						shotsTotal: 0.8 * f,
						passesKey: 0.5 * f,
						assists: 0.1 * f,
						dribblesSuccess: 0.4 * f,
						passesTotal: 30 * f,
						tackles: 1.5 * f,
						interceptions: 1 * f,
						blocks: 0.5 * f,
						dribblesPast: 1 / f,
						saves: 2 * f,
						goalsConceded: 2 / f,
						foulsCommitted: 1 / f,
						yellowCards: 0.2 / f,
						duels: 100,
						duelsWon: 40 + i * 4,
					},
					{ ratingMinutes: 6.2 + i * 0.1 },
				),
			);
		}
	}
	return out;
}

const attrKeys = [
	"attack",
	"creativity",
	"defense",
	"goalkeeping",
	"discipline",
	"overall",
] as const;

describe("computeAttributes", () => {
	it("(a) returns integers within 0-100", () => {
		const res = computeAttributes([
			...league(),
			player("Attacker", 0),
			player("Attacker", 3000, { goals: 5, shotsOn: 9, shotsTotal: 20 }),
		]);
		for (const r of res) {
			for (const k of attrKeys) {
				expect(Number.isInteger(r[k])).toBe(true);
				expect(r[k]).toBeGreaterThanOrEqual(0);
				expect(r[k]).toBeLessThanOrEqual(100);
			}
		}
	});

	it("(b) a 0-minute player sits near 25 and below the median of playing players", () => {
		const base = league();
		const zero = player("Midfielder", 0, {}, { ratingMinutes: null });
		const res = computeAttributes([...base, zero]);
		const z = res.find((r) => r.playerId === zero.playerId);
		expect(z).toBeDefined();
		for (const k of [
			"attack",
			"creativity",
			"defense",
			"goalkeeping",
			"discipline",
		] as const) {
			expect(Math.abs((z?.[k] ?? 0) - 25)).toBeLessThanOrEqual(3);
		}
		const mids = res.filter(
			(r) => r.position === "Midfielder" && r.minutes > 0,
		);
		const median = (k: (typeof attrKeys)[number]) =>
			[...mids.map((r) => r[k])].sort((x, y) => x - y)[
				Math.floor(mids.length / 2)
			] ?? 0;
		for (const k of [
			"attack",
			"creativity",
			"defense",
			"goalkeeping",
			"overall",
		] as const) {
			expect(z?.[k] ?? 100).toBeLessThan(median(k));
		}
	});

	it("(c) more minutes at the same per-90 stats moves the player further from the prior", () => {
		const stats = { goals: 0.8, shotsOn: 2, shotsTotal: 4 };
		const few = player("Attacker", 300, stats);
		const many = player("Attacker", 3000, stats);
		const res = computeAttributes([...league(), few, many]);
		const a = res.find((r) => r.playerId === few.playerId)?.attack ?? 0;
		const b = res.find((r) => r.playerId === many.playerId)?.attack ?? 0;
		expect(Math.abs(b - 25)).toBeGreaterThan(Math.abs(a - 25));
	});

	it("(d) a striker with more goals per 90 has higher attack", () => {
		const low = player("Attacker", 2000, {
			goals: 0.1,
			shotsOn: 0.5,
			shotsTotal: 1.5,
		});
		const high = player("Attacker", 2000, {
			goals: 0.7,
			shotsOn: 0.5,
			shotsTotal: 1.5,
		});
		const res = computeAttributes([...league(), low, high]);
		const a = res.find((r) => r.playerId === low.playerId)?.attack ?? 0;
		const b = res.find((r) => r.playerId === high.playerId)?.attack ?? 0;
		expect(b).toBeGreaterThan(a);
	});

	it("(e) more cards lower discipline", () => {
		const clean = player("Defender", 2000, { foulsCommitted: 0.8 });
		const dirty = player("Defender", 2000, {
			foulsCommitted: 0.8,
			yellowCards: 0.5,
			redCards: 0.1,
		});
		const res = computeAttributes([...league(), clean, dirty]);
		const a = res.find((r) => r.playerId === clean.playerId)?.discipline ?? 0;
		const b = res.find((r) => r.playerId === dirty.playerId)?.discipline ?? 0;
		expect(b).toBeLessThan(a);
	});

	it("(f) yields one result per input playerId, without duplicates", () => {
		const input = [...league(), player("Defender", 900)];
		const res = computeAttributes(input);
		expect(res).toHaveLength(input.length);
		expect(new Set(res.map((r) => r.playerId)).size).toBe(input.length);
	});

	it("(g) the position is a required typed field carried through to the result", () => {
		const gk = player("Goalkeeper", 2000, { saves: 3, goalsConceded: 1 });
		const res = computeAttributes([...league(), gk]);
		expect(res.find((r) => r.playerId === gk.playerId)?.position).toBe(
			"Goalkeeper",
		);
		// @ts-expect-error position cannot be null
		const bad: PlayerInput = { ...gk, position: null };
		expect(bad).toBeDefined();
	});

	it("falls back to the league-wide distribution for small position groups", () => {
		const small = [
			...league().filter((p) => p.position !== "Goalkeeper"),
			player("Goalkeeper", 2000, { saves: 3 }),
		];
		const res = computeAttributes(small);
		expect(res.every((r) => r.overall >= 0 && r.overall <= 100)).toBe(true);
	});
});
