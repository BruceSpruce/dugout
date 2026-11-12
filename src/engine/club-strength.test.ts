import { describe, expect, it } from "vitest";
import type { PlayerAttributes, Position } from "./attributes";
import {
	bestEleven,
	clubStrength,
	compareStrengthToTable,
	leagueTable,
	spearman,
} from "./club-strength";

let nextId = 1;
const player = (
	position: Position,
	overall: number,
	clubId = 1,
): PlayerAttributes => ({
	playerId: nextId++,
	name: `P${nextId}`,
	clubId,
	position,
	minutes: 2000,
	attack: 50,
	creativity: 50,
	defense: 50,
	goalkeeping: 50,
	discipline: 50,
	overall,
});

const many = (position: Position, overalls: number[]) =>
	overalls.map((o) => player(position, o));

describe("bestEleven / clubStrength", () => {
	it("(a) picks 1-4-4-2 from a full squad", () => {
		const squad = [
			...many("Goalkeeper", [70, 60]),
			...many("Defender", [80, 75, 70, 65, 40, 30]),
			...many("Midfielder", [85, 80, 75, 70, 50]),
			...many("Attacker", [90, 85, 60]),
		];
		const eleven = bestEleven(squad);
		expect(eleven).toHaveLength(11);
		const count = (p: Position) =>
			eleven.filter((x) => x.position === p).length;
		expect(count("Goalkeeper")).toBe(1);
		expect(count("Defender")).toBe(4);
		expect(count("Midfielder")).toBe(4);
		expect(count("Attacker")).toBe(2);
		expect(Math.min(...eleven.map((p) => p.overall))).toBe(65);
		// 845 / 11 = 76.8
		expect(clubStrength(squad)).toBe(76.8);
	});

	it("(b) fills a missing goalkeeper with the best remaining outfield player at x0.8", () => {
		const squad = [
			...many("Defender", [80, 70, 60, 50, 90]),
			...many("Midfielder", [70, 70, 70, 70]),
			...many("Attacker", [60, 60]),
		];
		const eleven = bestEleven(squad);
		expect(eleven).toHaveLength(11);
		expect(eleven.some((p) => p.position === "Goalkeeper")).toBe(false);
		// 5th defender is the best leftover: 50 -> 40 (the 90 is already in the back four)
		const filler = eleven.find((p) => p.overall === 40);
		expect(filler?.position).toBe("Defender");
	});

	it("fills with the best leftover outfield player, not a goalkeeper", () => {
		const squad = [
			...many("Goalkeeper", [50, 99]),
			...many("Defender", [60, 60, 60, 60]),
			...many("Midfielder", [60, 60, 60]),
			...many("Attacker", [60, 60, 100]),
		];
		const eleven = bestEleven(squad);
		expect(eleven).toHaveLength(11);
		expect(eleven.filter((p) => p.position === "Goalkeeper")).toHaveLength(1);
		// 3 midfielders -> the gap is filled by a leftover outfield 60 (x 0.8 = 48), never the 99 goalkeeper
		expect(eleven.some((p) => p.overall === 48)).toBe(true);
	});

	it("returns fewer than 11 for a small squad", () => {
		const squad = many("Defender", [50, 60, 70]);
		expect(bestEleven(squad)).toHaveLength(3);
		expect(clubStrength(squad)).toBe(60);
		expect(clubStrength([])).toBe(0);
	});
});

describe("leagueTable", () => {
	const clubs = [
		{ clubId: 1, name: "Alpha" },
		{ clubId: 2, name: "Beta" },
		{ clubId: 3, name: "Gamma" },
	];

	it("(c) gives 3 for a win, 1 for a draw, 0 for a loss", () => {
		const t = leagueTable(
			[
				{ homeClubId: 1, awayClubId: 2, homeGoals: 2, awayGoals: 0 },
				{ homeClubId: 2, awayClubId: 3, homeGoals: 1, awayGoals: 1 },
			],
			clubs,
		);
		const byId = new Map(t.map((r) => [r.clubId, r]));
		expect(byId.get(1)).toMatchObject({ points: 3, played: 1, goalDiff: 2 });
		expect(byId.get(2)).toMatchObject({ points: 1, played: 2, goalDiff: -2 });
		expect(byId.get(3)).toMatchObject({ points: 1, played: 1, goalDiff: 0 });
		expect(t.map((r) => r.clubId)).toEqual([1, 3, 2]);
		expect(t.map((r) => r.position)).toEqual([1, 2, 3]);
	});

	it("(c) orders by goal difference, then goals for, then name at equal points", () => {
		const t = leagueTable(
			[
				{ homeClubId: 1, awayClubId: 3, homeGoals: 1, awayGoals: 0 },
				{ homeClubId: 2, awayClubId: 3, homeGoals: 3, awayGoals: 1 },
			],
			clubs,
		);
		// Alpha 3 pts gd+1, Beta 3 pts gd+2
		expect(t.map((r) => r.name)).toEqual(["Beta", "Alpha", "Gamma"]);
		const tie = leagueTable([], clubs);
		expect(tie.map((r) => r.name)).toEqual(["Alpha", "Beta", "Gamma"]);
		const gf = leagueTable(
			[
				{ homeClubId: 2, awayClubId: 3, homeGoals: 2, awayGoals: 1 },
				{ homeClubId: 1, awayClubId: 3, homeGoals: 1, awayGoals: 0 },
			],
			clubs,
		);
		// equal points and goal diff (+1); Beta has more goals for
		expect(gf.map((r) => r.name).slice(0, 2)).toEqual(["Beta", "Alpha"]);
	});
});

describe("spearman", () => {
	it("(d) is 1 for identical and -1 for reversed ranks", () => {
		expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 10);
		expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1, 10);
	});

	it("(d) uses average ranks for ties", () => {
		// ranks of a: 1.5, 1.5, 3, 4 ; b: 1, 2, 3, 4
		const rho = spearman([1, 1, 2, 3], [1, 2, 3, 4]);
		const ra = [1.5, 1.5, 3, 4];
		const rb = [1, 2, 3, 4];
		const m = 2.5;
		let cov = 0;
		let va = 0;
		let vb = 0;
		for (let i = 0; i < 4; i++) {
			cov += ((ra[i] ?? 0) - m) * ((rb[i] ?? 0) - m);
			va += ((ra[i] ?? 0) - m) ** 2;
			vb += ((rb[i] ?? 0) - m) ** 2;
		}
		expect(rho).toBeCloseTo(cov / Math.sqrt(va * vb), 10);
		expect(rho).toBeGreaterThan(0.9);
		expect(rho).toBeLessThan(1);
	});

	it("returns 0 without variance", () => {
		expect(spearman([1, 1, 1], [1, 2, 3])).toBe(0);
	});
});

describe("compareStrengthToTable", () => {
	const names = ["A", "B", "C", "D", "E", "F", "G", "H"];
	const table = names.map((name, i) => ({
		clubId: i + 1,
		name,
		position: i + 1,
		played: 10,
		points: 30 - i,
		goalDiff: 0,
		goalsFor: 0,
	}));

	it("gives rho > 0 on agreement and ranks strongest first", () => {
		const strengths = table.map((t) => ({
			clubId: t.clubId,
			strength: 90 - t.position,
		}));
		const c = compareStrengthToTable(strengths, table);
		expect(c.rho).toBeCloseTo(1, 10);
		expect(c.top6Hits).toBe(6);
		expect(c.rows[0]).toMatchObject({
			clubId: 1,
			strengthRank: 1,
			tablePosition: 1,
			points: 30,
		});
	});

	it("(e) top6Hits is the intersection of the two top-6 sets", () => {
		// Strength top 6 = clubs 1-4 plus 7, 8; table top 6 = clubs 1-6 -> hits 1,2,3,4
		const strengths = [
			{ clubId: 1, strength: 80 },
			{ clubId: 2, strength: 79 },
			{ clubId: 3, strength: 78 },
			{ clubId: 4, strength: 77 },
			{ clubId: 7, strength: 76 },
			{ clubId: 8, strength: 75 },
			{ clubId: 5, strength: 60 },
			{ clubId: 6, strength: 50 },
		];
		const c = compareStrengthToTable(strengths, table);
		expect(c.top6Hits).toBe(4);
		expect(c.rho).toBeGreaterThan(0);
		const reversed = compareStrengthToTable(
			table.map((t) => ({ clubId: t.clubId, strength: t.position })),
			table,
		);
		expect(reversed.rho).toBeCloseTo(-1, 10);
		expect(reversed.top6Hits).toBe(4);
	});

	it("breaks strength ties by name, not by table position", () => {
		// "H" (8th) and "A" (1st) tie for 6th place in strength: by name "A" takes it,
		// so the 6th slot does not depend on the table being checked.
		const strengths = [
			{ clubId: 2, strength: 80 },
			{ clubId: 3, strength: 79 },
			{ clubId: 4, strength: 78 },
			{ clubId: 5, strength: 77 },
			{ clubId: 6, strength: 76 },
			{ clubId: 8, strength: 70 },
			{ clubId: 1, strength: 70 },
			{ clubId: 7, strength: 10 },
		];
		const byName = compareStrengthToTable(strengths, table);
		expect(byName.rows[5]?.name).toBe("A");
		const renamed = table.map((t) =>
			t.clubId === 1 ? { ...t, name: "Z" } : t,
		);
		const c = compareStrengthToTable(strengths, renamed);
		expect(c.rows[5]?.name).toBe("H");
		expect(c.top6Hits).toBe(5);
	});
});
