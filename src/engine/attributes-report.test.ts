import { describe, expect, it } from "vitest";
import type { Counters, PlayerInput, Position } from "./attributes";
import {
	type AttributesReportInput,
	buildAttributesReport,
} from "./attributes-report";

const counters = (goals: number): Counters => ({
	goals,
	penaltyScored: 0,
	shotsTotal: goals * 4,
	shotsOn: goals * 2,
	assists: 0,
	passesKey: 5,
	passesTotal: 500,
	dribblesSuccess: 5,
	tackles: 20,
	interceptions: 10,
	blocks: 5,
	duels: 100,
	duelsWon: 50,
	dribblesPast: 5,
	saves: 20,
	goalsConceded: 20,
	penaltySaved: 0,
	foulsCommitted: 10,
	yellowCards: 2,
	yellowRedCards: 0,
	redCards: 0,
});

const POSITIONS: Position[] = [
	"Goalkeeper",
	...Array<Position>(4).fill("Defender"),
	...Array<Position>(4).fill("Midfielder"),
	...Array<Position>(3).fill("Attacker"),
];

// Club i (1 = best): squad quality falls with i; in `inverted` mode the table runs the other way.
function build(nClubs: number, inverted: boolean): AttributesReportInput {
	const clubs = Array.from({ length: nClubs }, (_, i) => ({
		clubId: i + 1,
		name: `Club ${i + 1}`,
		apiId: 100 + i + 1,
	}));
	const players: PlayerInput[] = [];
	let id = 1;
	for (const c of clubs) {
		for (const position of POSITIONS) {
			players.push({
				playerId: id++,
				name: `Player ${id}`,
				clubId: c.clubId,
				position,
				minutes: 2500,
				ratingMinutes: 7.5 - c.clubId * 0.05,
				clubPlayedMinutes: 38 * 90,
				counters: counters(Math.max(0, 25 - c.clubId)),
			});
		}
	}
	// Club i beats every weaker club (or every stronger one when inverted).
	const results = [];
	for (const h of clubs) {
		for (const a of clubs) {
			if (h.clubId === a.clubId) continue;
			const homeWins = inverted ? h.clubId > a.clubId : h.clubId < a.clubId;
			results.push({
				homeClubId: h.clubId,
				awayClubId: a.clubId,
				homeGoals: homeWins ? 2 : 0,
				awayGoals: homeWins ? 0 : 2,
			});
		}
	}
	return { season: "39/2024", players, clubs, results };
}

describe("buildAttributesReport", () => {
	it("ranking mode fits in 30 lines and passes when strength matches the table", () => {
		const r = buildAttributesReport(build(20, false));
		expect(r.lines.length).toBeLessThanOrEqual(30);
		expect(r.lines[1]).toMatch(
			/^rho=\d\.\d\d \(min 0\.70\) top6=\d\/6 \(min 4\) → PASS$/,
		);
		expect(r.exitCode).toBe(0);
	});

	it("fails with exit code 3 when the ranking contradicts the table", () => {
		const r = buildAttributesReport(build(20, true));
		expect(r.lines[1]).toContain("→ FAIL");
		expect(r.lines[1]).toContain("rho=-");
		expect(r.exitCode).toBe(3);
	});

	it("honours custom thresholds", () => {
		const r = buildAttributesReport(build(20, false), { top6Min: 7 });
		expect(r.lines[1]).toContain("(min 7)");
		expect(r.exitCode).toBe(3);
	});

	it("club mode lists the squad, marks the eleven with * and exits 0", () => {
		const r = buildAttributesReport(build(20, true), { club: "club 3" });
		expect(r.exitCode).toBe(0);
		expect(r.lines[0]).toContain("Club 3");
		expect(r.lines[1]).toContain("poz");
		expect(r.lines[1]).toContain("OGL");
		const squadLines = r.lines.slice(2);
		expect(squadLines).toHaveLength(POSITIONS.length);
		expect(squadLines.filter((l) => l.startsWith("*"))).toHaveLength(11);
		expect(squadLines[0]).toContain("GK");
	});

	it("club mode accepts an apiId", () => {
		const r = buildAttributesReport(build(20, false), { club: "105" });
		expect(r.exitCode).toBe(0);
		expect(r.lines[0]).toContain("Club 5");
	});

	it("unknown club gives a message and exit code 1", () => {
		const r = buildAttributesReport(build(20, false), { club: "Nowhere FC" });
		expect(r.exitCode).toBe(1);
		expect(r.lines.join("\n")).toContain("Nowhere FC");
	});
});
