import { describe, expect, it } from "vitest";

import fixturesRaw from "./__fixtures__/fixtures.json";
import pageA from "./__fixtures__/players-page-a.json";
import pageB from "./__fixtures__/players-page-b.json";
import teamsRaw from "./__fixtures__/teams.json";
import {
	normalizeCompetitionSeason,
	normalizeFixtures,
	normalizePlayers,
	normalizeTeams,
	parseMeasure,
	parseRating,
	parseRound,
} from "./normalize";

const LEAGUE = 39;
const all = normalizePlayers([pageA, pageB], LEAGUE);
const squadOf = (id: number) => all.squad.find((s) => s.playerApiId === id);
const statsOf = (id: number) => all.stats.filter((s) => s.playerApiId === id);

describe("parsers", () => {
	it("parses rating strings and rejects garbage", () => {
		expect(parseRating("6.964516")).toBe(6.964516);
		expect(parseRating(null)).toBeNull();
		expect(parseRating("n/a")).toBeNull();
	});

	it("parses height and weight with or without units", () => {
		expect(parseMeasure("180 cm")).toBe(180);
		expect(parseMeasure("75 kg")).toBe(75);
		expect(parseMeasure("183")).toBe(183);
		expect(parseMeasure(null)).toBeNull();
		expect(parseMeasure("tall")).toBeNull();
	});

	it("extracts the round number and errors on other formats", () => {
		expect(parseRound("Regular Season - 12")).toBe(12);
		expect(() => parseRound("Quarter-finals")).toThrow(/Quarter-finals/);
	});
});

describe("normalizeTeams", () => {
	it("maps teams to club rows", () => {
		const clubs = normalizeTeams(teamsRaw);
		expect(clubs).toHaveLength(2);
		expect(clubs[0]).toMatchObject({
			apiId: 33,
			name: "Manchester United",
			code: "MUN",
			country: "England",
		});
		expect(clubs[0]?.logoUrl).toContain("33.png");
	});
});

describe("normalizeFixtures", () => {
	const rows = normalizeFixtures(fixturesRaw);

	it("parses rounds from two different match days", () => {
		expect(rows.map((r) => r.round)).toEqual([1, 12]);
	});

	it("maps clubs, kickoff, status, goals and half-time score", () => {
		expect(rows[0]).toMatchObject({
			apiId: 1208021,
			homeClubApiId: 33,
			status: "FT",
			homeGoals: 1,
			awayGoals: 0,
			homeGoalsHt: 0,
			awayGoalsHt: 0,
		});
		expect(rows[0]?.kickoffAt.toISOString()).toBe("2024-08-16T19:00:00.000Z");
	});

	it("keeps null goals for unplayed fixtures", () => {
		const raw = structuredClone(fixturesRaw);
		const r = raw.response[0];
		if (!r) throw new Error("fixture missing");
		r.goals = { home: null, away: null } as never;
		r.score.halftime = { home: null, away: null } as never;
		r.fixture.status.short = "NS";
		const [row] = normalizeFixtures(raw);
		expect(row).toMatchObject({
			status: "NS",
			homeGoals: null,
			awayGoals: null,
			homeGoalsHt: null,
			awayGoalsHt: null,
		});
	});

	it("fails on an unsupported round", () => {
		const raw = structuredClone(fixturesRaw);
		const r = raw.response[0];
		if (!r) throw new Error("fixture missing");
		r.league.round = "Relegation Play-offs";
		expect(() => normalizeFixtures(raw)).toThrow(/Relegation Play-offs/);
	});

	it("derives the competition season from the league object and kickoffs", () => {
		expect(normalizeCompetitionSeason(fixturesRaw)).toMatchObject({
			leagueApiId: 39,
			season: 2024,
			name: "Premier League",
			country: "England",
			startsOn: "2024-08-16",
		});
	});
});

describe("normalizePlayers", () => {
	it("turns null counters into 0 and keeps the player", () => {
		const [s] = statsOf(74); // Amrabat: every counter null
		expect(s).toMatchObject({
			appearances: 0,
			minutes: 0,
			goals: 0,
			yellowCards: 0,
			penaltySaved: 0,
			rating: null,
			passesAccuracyRaw: null,
		});
		expect(squadOf(74)?.clubApiId).toBe(33);
	});

	it("converts rating and keeps passes accuracy raw", () => {
		const [eriksen] = statsOf(174);
		expect(eriksen?.rating).toBeCloseTo(6.936363, 6);
		expect(eriksen?.minutes).toBe(1092);
		const [tie] = statsOf(9001);
		expect(tie?.passesAccuracyRaw).toBe(15);
	});

	it("parses height and weight of players", () => {
		const p = all.players.find((x) => x.apiId === 9001);
		expect(p).toMatchObject({ heightCm: 181, weightKg: 75 });
		expect(all.players.find((x) => x.apiId === 174)?.heightCm).toBe(182);
	});

	it("keeps a 0-minute player with a squad place", () => {
		const [s] = statsOf(14); // Dahoud
		expect(s?.minutes).toBe(0);
		expect(s?.appearances).toBe(0);
		expect(squadOf(14)?.clubApiId).toBe(51);
	});

	it("merges a transferred player across pages: two stats rows, one squad place", () => {
		const sancho = statsOf(
			all.players.find((p) => p.name === "J. Sancho")?.apiId ?? -1,
		);
		expect(sancho.map((s) => s.clubApiId).sort()).toEqual([33, 49]);
		expect(all.players.filter((p) => p.name === "J. Sancho")).toHaveLength(1);
		const id = sancho[0]?.playerApiId ?? -1;
		expect(all.squad.filter((s) => s.playerApiId === id)).toHaveLength(1);
		expect(squadOf(id)?.clubApiId).toBe(49); // 1764 min vs 0 min
	});

	it("breaks a minutes tie by higher rating, even when it comes first", () => {
		expect(statsOf(9001)).toHaveLength(2);
		expect(squadOf(9001)?.clubApiId).toBe(33);
	});

	it("breaks a full tie by the later entry", () => {
		expect(squadOf(9002)?.clubApiId).toBe(34);
		expect(squadOf(9002)?.position).toBe("Defender");
	});

	it("treats a null rating as the lowest", () => {
		expect(squadOf(9003)?.clubApiId).toBe(33);
	});

	it("skips entries of other leagues", () => {
		expect(statsOf(9004).map((s) => s.clubApiId)).toEqual([34]);
		expect(squadOf(9004)?.clubApiId).toBe(34);
	});

	it("drops players without any entry in the imported league", () => {
		const out = normalizePlayers([pageA], 999);
		expect(out).toEqual({ players: [], stats: [], squad: [] });
	});

	it("gives every player exactly one squad place", () => {
		const ids = all.squad.map((s) => s.playerApiId);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids.length).toBe(all.players.length);
	});

	it("lets a later duplicate (player-<id>.json) replace the same club entry", () => {
		const dup = structuredClone(pageA);
		const row = dup.response.find((r) => r.player.id === 174);
		const stat = row?.statistics[0];
		if (!stat) throw new Error("fixture missing");
		stat.games.minutes = 2000;
		const out = normalizePlayers([pageA, dup], LEAGUE);
		const eriksen = out.stats.filter((s) => s.playerApiId === 174);
		expect(eriksen).toHaveLength(1);
		expect(eriksen[0]?.minutes).toBe(2000);
	});
});
