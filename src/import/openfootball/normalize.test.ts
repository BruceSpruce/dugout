import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { OPEN_LEAGUES, OPEN_SEASON } from "./leagues";
import {
	localToUtc,
	normalizeOpenSeason,
	type RawSeason,
	slugKey,
} from "./normalize";

const load = (code: string): RawSeason =>
	JSON.parse(
		readFileSync(
			join(process.cwd(), "data/openfootball/2024-25", `${code}.json`),
			"utf8",
		),
	) as RawSeason;
const league = (code: string) => {
	const l = OPEN_LEAGUES.find((x) => x.code === code);
	if (!l) throw new Error(code);
	return l;
};

describe("OPEN_LEAGUES", () => {
	it("has 8 leagues with names from league-queue", () => {
		expect(OPEN_LEAGUES).toHaveLength(8);
		expect(league("en.1").name).toBe("Premier League");
		expect(league("pt.1").leagueApiId).toBe(94);
	});
});

describe("normalizeOpenSeason on real files", () => {
	const cases: [string, number, number, number, number][] = [
		["en.1", 20, 38, 380, 0],
		["en.2", 24, 46, 552, 5],
		["es.1", 20, 38, 380, 0],
		["it.1", 20, 38, 380, 0],
		["de.1", 18, 34, 306, 0],
		["fr.1", 18, 34, 306, 0],
		["nl.1", 18, 34, 306, 0],
		["pt.1", 18, 34, 306, 0],
	];
	for (const [code, clubs, rounds, fixtures, skipped] of cases) {
		it(`${code}: ${clubs}/${rounds}/${fixtures}, skipped ${skipped}`, () => {
			const n = normalizeOpenSeason(load(code), league(code), OPEN_SEASON);
			expect(n.clubs).toHaveLength(clubs);
			expect(Math.max(...n.fixtures.map((f) => f.round))).toBe(rounds);
			expect(n.fixtures).toHaveLength(fixtures);
			expect(n.skipped).toBe(skipped);
			expect(new Set(n.fixtures.map((f) => f.sourceKey)).size).toBe(fixtures);
			expect(n.competition.leagueApiId).toBe(league(code).leagueApiId);
			expect(n.competition.startsOn < n.competition.endsOn).toBe(true);
		});
	}

	it("converts first PL match to UTC and maps score", () => {
		const n = normalizeOpenSeason(load("en.1"), league("en.1"), OPEN_SEASON);
		const f = n.fixtures[0];
		expect(f?.kickoffAt.toISOString()).toBe("2024-08-16T19:00:00.000Z");
		expect(f?.status).toBe("FT");
		expect([f?.homeGoals, f?.awayGoals, f?.homeGoalsHt]).toEqual([1, 0, 0]);
	});

	it("unplayed matches are NS with null goals (es.1)", () => {
		const n = normalizeOpenSeason(load("es.1"), league("es.1"), OPEN_SEASON);
		const ns = n.fixtures.filter((f) => f.status === "NS");
		expect(ns).toHaveLength(10);
		for (const f of ns) {
			expect(f.homeGoals).toBeNull();
			expect(f.awayGoalsHt).toBeNull();
		}
	});

	it("awarded match keeps ft score without ht (de.1)", () => {
		const n = normalizeOpenSeason(load("de.1"), league("de.1"), OPEN_SEASON);
		const f = n.fixtures.find(
			(x) => x.round === 14 && x.homeKey === "of:1-fc-union-berlin",
		);
		expect(f?.status).toBe("FT");
		expect([f?.homeGoals, f?.awayGoals]).toEqual([0, 2]);
		expect(f?.homeGoalsHt).toBeNull();
	});
});

describe("broken schedules", () => {
	const l = league("de.1");
	const mk = (round: string, a: string, b: string) => ({
		round,
		date: "2024-09-01",
		time: "15:30",
		team1: a,
		team2: b,
	});
	const base = [
		mk("Matchday 1", "A", "B"),
		mk("Matchday 1", "C", "D"),
		mk("Matchday 2", "A", "C"),
		mk("Matchday 2", "B", "D"),
		mk("Matchday 3", "A", "D"),
		mk("Matchday 3", "B", "C"),
		mk("Matchday 4", "B", "A"),
		mk("Matchday 4", "D", "C"),
		mk("Matchday 5", "C", "A"),
		mk("Matchday 5", "D", "B"),
		mk("Matchday 6", "D", "A"),
		mk("Matchday 6", "C", "B"),
	];
	it("accepts a complete synthetic schedule", () => {
		const n = normalizeOpenSeason({ matches: base }, l, 2024);
		expect(n.fixtures).toHaveLength(12);
	});
	it("rejects a club twice in a round", () => {
		const m = base.map((x) => ({ ...x }));
		m[1] = mk("Matchday 1", "A", "D");
		expect(() => normalizeOpenSeason({ matches: m }, l, 2024)).toThrow();
	});
	it("rejects a missing pair", () => {
		expect(() =>
			normalizeOpenSeason({ matches: base.slice(0, -1) }, l, 2024),
		).toThrow();
	});
});

describe("localToUtc", () => {
	const z = (d: string, t: string, tz: string) =>
		localToUtc(d, t, tz).toISOString();
	it("London BST and GMT", () => {
		expect(z("2024-08-16", "20:00", "Europe/London")).toBe(
			"2024-08-16T19:00:00.000Z",
		);
		expect(z("2024-12-26", "15:00", "Europe/London")).toBe(
			"2024-12-26T15:00:00.000Z",
		);
	});
	it("London transition days", () => {
		expect(z("2024-10-27", "00:30", "Europe/London")).toBe(
			"2024-10-26T23:30:00.000Z",
		);
		expect(z("2024-10-27", "15:00", "Europe/London")).toBe(
			"2024-10-27T15:00:00.000Z",
		);
		expect(z("2025-03-30", "00:30", "Europe/London")).toBe(
			"2025-03-30T00:30:00.000Z",
		);
		expect(z("2025-03-30", "15:00", "Europe/London")).toBe(
			"2025-03-30T14:00:00.000Z",
		);
	});
	it("Berlin CET/CEST and transition days", () => {
		expect(z("2024-08-23", "20:30", "Europe/Berlin")).toBe(
			"2024-08-23T18:30:00.000Z",
		);
		expect(z("2024-12-14", "15:30", "Europe/Berlin")).toBe(
			"2024-12-14T14:30:00.000Z",
		);
		expect(z("2024-10-27", "01:30", "Europe/Berlin")).toBe(
			"2024-10-26T23:30:00.000Z",
		);
		expect(z("2024-10-27", "15:30", "Europe/Berlin")).toBe(
			"2024-10-27T14:30:00.000Z",
		);
		expect(z("2025-03-30", "01:30", "Europe/Berlin")).toBe(
			"2025-03-30T00:30:00.000Z",
		);
		expect(z("2025-03-30", "15:30", "Europe/Berlin")).toBe(
			"2025-03-30T13:30:00.000Z",
		);
	});
});

describe("slugKey", () => {
	it("strips diacritics and punctuation", () => {
		expect(slugKey("1. FC Union Berlin")).toBe("1-fc-union-berlin");
		expect(slugKey("Real Betis Balompié")).toBe("real-betis-balompie");
	});
});
