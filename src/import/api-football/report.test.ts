import { describe, expect, it } from "vitest";

import { type Aggregates, buildReport } from "./report";

function club(name: string, over: Partial<Aggregates["clubs"][number]> = {}) {
	return {
		name,
		squad: 25,
		withMinutes: 22,
		minutes: 38 * 990,
		playedFixtures: 38,
		...over,
	};
}

function healthy(): Aggregates {
	return {
		season: {
			name: "Premier League",
			startsOn: "2024-08-16",
			endsOn: "2025-05-25",
		},
		clubs: [club("A"), club("B", { squad: 30, withMinutes: 26 })],
		fixtures: {
			total: 4,
			byStatus: { FT: 4 },
			rounds: [1, 1, 2, 2],
			finishedWithoutScore: 0,
		},
		players: {
			total: 55,
			withMinutes: 48,
			byPosition: { Defender: 20, Goalkeeper: 5 },
		},
		multiClub: { count: 1, examples: ["X (A+B)"] },
		goals: { fixtures: 10, players: 8 },
	};
}

describe("buildReport", () => {
	it("healthy season: all sections, section 8 empty, exit 0", () => {
		const r = buildReport(healthy());
		expect(r.exitCode).toBe(0);
		expect(r.warnings).toEqual([]);
		expect(r.lines.at(-1)).toBe("8. Warnings: none");
		expect(r.lines.join("\n")).toContain("per round min/max=2/2");
		expect(r.lines.join("\n")).toContain("size min/max=25/30");
		expect(r.lines.join("\n")).toContain("players with minutes min/max=22/26");
		expect(r.lines.join("\n")).toContain("diff=2");
		expect(r.lines.join("\n")).toContain("minutes coverage min/max=1.00/1.00");
	});

	it("warns about clubs without squad and FT fixtures without score", () => {
		const a = healthy();
		a.clubs.push(club("C", { squad: 0, withMinutes: 0 }));
		a.fixtures.finishedWithoutScore = 2;
		const r = buildReport(a);
		expect(r.exitCode).toBe(3);
		expect(r.warnings.join("|")).toContain("clubs without squad: C");
		expect(r.warnings.join("|")).toContain("FT fixtures without score: 2");
	});

	it("lists clubs below minutes coverage 0.95 with their ratio", () => {
		const a = healthy();
		a.clubs.push(club("Low", { minutes: Math.round(38 * 990 * 0.8) }));
		const r = buildReport(a);
		expect(r.exitCode).toBe(3);
		const text = r.lines.join("\n");
		expect(text).toContain("below 0.95: Low 0.80");
		expect(text).toContain("min/max=0.80/1.00");
	});

	it("club exactly at 0.95 is not flagged", () => {
		const a = healthy();
		a.clubs.push(club("Edge", { minutes: 38 * 990 * 0.95 }));
		expect(buildReport(a).exitCode).toBe(0);
	});

	it("shows at most 5 multi-club examples", () => {
		const a = healthy();
		a.multiClub = {
			count: 8,
			examples: ["1", "2", "3", "4", "5", "6", "7", "8"],
		};
		const line = buildReport(a).lines.find((l) => l.startsWith("5."));
		expect(line).toContain("5)");
		expect(line).not.toContain("6");
	});

	it("season not loaded: exit 3", () => {
		const r = buildReport({ ...healthy(), season: null });
		expect(r.exitCode).toBe(3);
		expect(r.lines[0]).toContain("not loaded");
	});
});
