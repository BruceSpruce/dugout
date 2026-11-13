import { describe, expect, it } from "vitest";
import type { Counters, PlayerInput, Position } from "./attributes";
import {
	buildCalibrationReport,
	type CalibrationReportInput,
} from "./calibration-report";
import type { MatchModel } from "./match";

const counters = (goals: number): Counters => ({
	goals,
	penaltyScored: 0,
	shotsTotal: goals * 4,
	shotsOn: goals * 2,
	assists: goals,
	passesKey: 5 + goals,
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
	...Array<Position>(5).fill("Defender"),
	...Array<Position>(5).fill("Midfielder"),
	...Array<Position>(4).fill("Attacker"),
];

const N_CLUBS = 20;

function build(): CalibrationReportInput {
	const clubs = Array.from({ length: N_CLUBS }, (_, i) => ({
		clubId: i + 1,
		name: `Club ${i + 1}`,
		apiId: 100 + i + 1,
	}));
	const players: PlayerInput[] = [];
	let id = 1;
	for (const c of clubs) {
		POSITIONS.forEach((position, k) => {
			players.push({
				playerId: id,
				name: `Player ${id}`,
				clubId: c.clubId,
				position,
				// Starters play a lot, reserves little; quality falls with club number.
				minutes: k % 2 === 0 ? 2800 - k * 20 : 600 + k * 30,
				ratingMinutes: 7.8 - c.clubId * 0.006 - (k % 3) * 0.1,
				clubPlayedMinutes: 38 * 90,
				counters: counters(
					Math.max(0, Math.round(26 - c.clubId * 0.15) - (k % 4)),
				),
			});
			id++;
		});
	}
	// Double round-robin (circle method): 38 rounds x 10 matches, each pair home and away.
	const fixtures = [];
	const results = [];
	const ids = clubs.map((c) => c.clubId);
	for (let leg = 0; leg < 2; leg++) {
		for (let r = 0; r < N_CLUBS - 1; r++) {
			for (let i = 0; i < N_CLUBS / 2; i++) {
				const x = ids[i] ?? 0;
				const y = ids[N_CLUBS - 1 - i] ?? 0;
				const flip = ((i + r) % 2 === 0) !== (leg === 0);
				const h = flip ? y : x;
				const a = flip ? x : y;
				fixtures.push({
					round: leg * (N_CLUBS - 1) + r + 1,
					homeClubId: h,
					awayClubId: a,
				});
				results.push({
					homeClubId: h,
					awayClubId: a,
					homeGoals: h < a ? 2 : 1,
					awayGoals: 1,
				});
			}
			ids.splice(1, 0, ids.pop() ?? 0);
		}
	}
	return { season: "39/2024", players, clubs, results, fixtures };
}

const SEASONS = 30;
const fixedNow = () => 0;

describe("buildCalibrationReport", () => {
	it("prints header, metrics, top 6, two lineup lines and a final verdict in <= 30 lines", () => {
		const r = buildCalibrationReport(build(), {
			seasons: SEASONS,
			now: fixedNow,
		});
		expect([0, 3]).toContain(r.exitCode);
		expect(r.lines.length).toBeLessThanOrEqual(30);
		expect(r.lines[0]).toContain(`sezonów ${SEASONS}`);
		expect(r.lines[0]).toContain("seed 1");
		expect(r.lines[0]).toContain("ms/sezon");
		const text = r.lines.join("\n");
		for (const label of [
			"gole/mecz",
			"wygrane gosp. %",
			"remisy %",
			"wygrane gości %",
			"odch. std pkt",
			"mistrz pkt",
			"ostatni pkt",
			"Spearman",
		]) {
			expect(text).toContain(label);
		}
		expect(r.lines.filter((l) => /^ {0,1}\d\. /.test(l))).toHaveLength(6);
		expect(r.lines.filter((l) => l.includes("2·SE"))).toHaveLength(2);
		const last = r.lines[r.lines.length - 1] ?? "";
		expect(last.startsWith("→ PASS") || last.startsWith("→ FAIL (")).toBe(true);
		expect(r.exitCode === 0).toBe(last === "→ PASS");
	});

	it("fails with exit 3 and the gate name when goals leave the PRD range", () => {
		const model: MatchModel = {
			logBaseGoals: 1.5,
			homeAdvantage: 0.22,
			strengthBeta: 0.02,
			drawRho: 0,
		};
		const r = buildCalibrationReport(build(), {
			seasons: SEASONS,
			now: fixedNow,
			model,
		});
		expect(r.exitCode).toBe(3);
		const last = r.lines[r.lines.length - 1] ?? "";
		expect(last).toMatch(/^→ FAIL \(.*goalsPerMatch/);
	});

	it("passes all gates for a calibrated model on a 20-club league", () => {
		const r = buildCalibrationReport(build(), {
			seasons: SEASONS,
			now: fixedNow,
			model: {
				logBaseGoals: 0.07,
				homeAdvantage: 0.25,
				strengthBeta: 0.055,
				drawRho: -0.1,
			},
		});
		expect(r.exitCode).toBe(0);
		expect(r.lines[r.lines.length - 1]).toBe("→ PASS");
	});

	it("fails on pointsStd when strength does not spread the table", () => {
		const r = buildCalibrationReport(build(), {
			seasons: SEASONS,
			now: fixedNow,
			model: {
				logBaseGoals: 0.07,
				homeAdvantage: 0.25,
				strengthBeta: 0,
				drawRho: -0.1,
			},
		});
		expect(r.exitCode).toBe(3);
		expect(r.lines[r.lines.length - 1]).toMatch(/^→ FAIL \(.*pointsStd/);
	});

	it("fails on homeWinPct when home advantage is strongly negative", () => {
		const r = buildCalibrationReport(build(), {
			seasons: SEASONS,
			now: fixedNow,
			model: {
				logBaseGoals: 0.17,
				homeAdvantage: -1,
				strengthBeta: 0.02,
				drawRho: 0,
			},
		});
		expect(r.exitCode).toBe(3);
		expect(r.lines[r.lines.length - 1]).toMatch(/^→ FAIL \(.*homeWinPct/);
	});

	it("fails on drawPct when goals are so rare that 0-0 dominates", () => {
		const r = buildCalibrationReport(build(), {
			seasons: SEASONS,
			now: fixedNow,
			model: {
				logBaseGoals: -1.5,
				homeAdvantage: 0.22,
				strengthBeta: 0.02,
				drawRho: 0,
			},
		});
		expect(r.exitCode).toBe(3);
		expect(r.lines[r.lines.length - 1]).toMatch(/^→ FAIL \(.*drawPct/);
	});

	it("returns exit 1 and one line for an unknown club", () => {
		const r = buildCalibrationReport(build(), {
			seasons: SEASONS,
			club: "Nowhere FC",
		});
		expect(r.exitCode).toBe(1);
		expect(r.lines).toEqual(["Unknown club: Nowhere FC"]);
	});

	it("accepts --club by name (case-insensitive) and by apiId", () => {
		const byName = buildCalibrationReport(build(), {
			seasons: SEASONS,
			club: "club 3",
			now: fixedNow,
		});
		const byId = buildCalibrationReport(build(), {
			seasons: SEASONS,
			club: "103",
			now: fixedNow,
		});
		expect(byName.lines.join("\n")).toContain("test składu: Club 3");
		expect(byId.lines).toEqual(byName.lines);
	});

	it("is deterministic for the same seed and differs for another seed", () => {
		const a = buildCalibrationReport(build(), {
			seasons: SEASONS,
			seed: 7,
			now: fixedNow,
		});
		const b = buildCalibrationReport(build(), {
			seasons: SEASONS,
			seed: 7,
			now: fixedNow,
		});
		const c = buildCalibrationReport(build(), {
			seasons: SEASONS,
			seed: 8,
			now: fixedNow,
		});
		expect(b.lines).toEqual(a.lines);
		expect(c.lines).not.toEqual(a.lines);
	});
});
