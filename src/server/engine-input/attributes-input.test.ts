import { describe, expect, it } from "vitest";
import type { Counters } from "~/engine/attributes";
import {
	aggregatePlayerRows,
	type SquadRowInput,
	type StatsRowInput,
} from "./attributes-input";

const counters = (over: Partial<Counters> = {}): Counters => ({
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
	...over,
});

const row = (over: Partial<StatsRowInput> = {}): StatsRowInput => ({
	playerId: 1,
	clubId: 10,
	position: "Attacker",
	minutes: 0,
	rating: null,
	counters: counters(),
	...over,
});

const member = (over: Partial<SquadRowInput> = {}): SquadRowInput => ({
	playerId: 1,
	name: "Sancho",
	clubId: 20,
	position: "Attacker",
	...over,
});

const played = new Map([
	[10, 20],
	[20, 38],
]);

describe("aggregatePlayerRows", () => {
	it("sums rows from two clubs, takes the club from squad_member", () => {
		const [p] = aggregatePlayerRows(
			[
				row({
					clubId: 10,
					minutes: 900,
					rating: 7,
					counters: counters({ goals: 2, assists: 1 }),
				}),
				row({
					clubId: 20,
					minutes: 300,
					rating: 6,
					counters: counters({ goals: 1, assists: 3 }),
				}),
			],
			[member({ clubId: 20 })],
			played,
		);
		expect(p?.clubId).toBe(20);
		expect(p?.minutes).toBe(1200);
		expect(p?.counters.goals).toBe(3);
		expect(p?.counters.assists).toBe(4);
		expect(p?.ratingMinutes).toBeCloseTo((7 * 900 + 6 * 300) / 1200, 10);
		expect(p?.clubPlayedMinutes).toBe(38 * 90);
	});

	it("falls back to the position of the row with most minutes when squad position is null", () => {
		const [p] = aggregatePlayerRows(
			[
				row({ position: "Midfielder", minutes: 200 }),
				row({ clubId: 20, position: "Defender", minutes: 700 }),
			],
			[member({ position: null })],
			played,
		);
		// Defender, not the Midfielder default, proves the row fallback is used.
		expect(p?.position).toBe("Defender");
	});

	it("maps the API alias Forward to Attacker in squad and stat rows", () => {
		const [p] = aggregatePlayerRows(
			[row({ position: "Forward", minutes: 100 })],
			[member({ position: "Forward" })],
			played,
		);
		expect(p?.position).toBe("Attacker");
		const [q] = aggregatePlayerRows(
			[row({ position: "Forward", minutes: 100 })],
			[member({ position: null })],
			played,
		);
		expect(q?.position).toBe("Attacker");
	});

	it("falls back to Midfielder when no position is known", () => {
		const [p] = aggregatePlayerRows(
			[row({ position: null, minutes: 100 })],
			[member({ position: null })],
			played,
		);
		expect(p?.position).toBe("Midfielder");
	});

	it("gives a squad member without stat rows zero counters and 0 minutes", () => {
		const out = aggregatePlayerRows(
			[],
			[member({ playerId: 5, name: "Bench", position: "Goalkeeper" })],
			played,
		);
		expect(out).toHaveLength(1);
		expect(out[0]?.minutes).toBe(0);
		expect(out[0]?.ratingMinutes).toBeNull();
		expect(Object.values(out[0]?.counters ?? {}).every((v) => v === 0)).toBe(
			true,
		);
		expect(out[0]?.position).toBe("Goalkeeper");
	});

	it("ignores the rating of a 0-minute row", () => {
		const [p] = aggregatePlayerRows(
			[
				row({ clubId: 10, minutes: 0, rating: 9 }),
				row({ clubId: 20, minutes: 500, rating: 6.5 }),
			],
			[member()],
			played,
		);
		expect(p?.ratingMinutes).toBeCloseTo(6.5, 10);
		const [q] = aggregatePlayerRows(
			[row({ minutes: 0, rating: 9 })],
			[member()],
			played,
		);
		expect(q?.ratingMinutes).toBeNull();
	});

	it("keeps one input per squad member", () => {
		const out = aggregatePlayerRows(
			[row({ playerId: 1, minutes: 90 }), row({ playerId: 1, minutes: 90 })],
			[member({ playerId: 1 }), member({ playerId: 2, name: "Other" })],
			played,
		);
		expect(out.map((p) => p.playerId)).toEqual([1, 2]);
	});
});
