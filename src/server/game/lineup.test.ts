import { describe, expect, it } from "vitest";

import type { PlayerAttributes, Position } from "~/engine/attributes";
import { aiProposal, sortSquad, validateLineup } from "./lineup";

const player = (
	playerId: number,
	position: Position,
	overall: number,
): PlayerAttributes => ({
	playerId,
	name: `P${playerId}`,
	clubId: 1,
	position,
	minutes: 900,
	attack: overall,
	creativity: overall,
	defense: overall,
	goalkeeping: overall,
	discipline: overall,
	overall,
});

// 2 GK, 7 DEF, 7 MID, 5 ATT = 21 players, ids 1..21.
const squad: PlayerAttributes[] = [
	...[1, 2].map((i) => player(i, "Goalkeeper", 70 - i)),
	...[3, 4, 5, 6, 7, 8, 9].map((i) => player(i, "Defender", 80 - i)),
	...[10, 11, 12, 13, 14, 15, 16].map((i) => player(i, "Midfielder", 90 - i)),
	...[17, 18, 19, 20, 21].map((i) => player(i, "Attacker", 100 - i)),
];
const ids = new Set(squad.map((p) => p.playerId));

const good = {
	formation: "4-4-2",
	style: "balanced",
	starters: [1, 3, 4, 5, 6, 10, 11, 12, 13, 17, 18],
	bench: [2, 7, 8, 9, 14, 15, 16, 19, 20],
};

const error = (r: ReturnType<typeof validateLineup>) => (r.ok ? null : r.error);

describe("validateLineup", () => {
	it("accepts a correct lineup", () => {
		expect(validateLineup(good, ids)).toEqual({ ok: true });
		expect(validateLineup({ ...good, bench: [] }, ids)).toEqual({ ok: true });
	});

	it("rejects too few starters", () => {
		const r = validateLineup(
			{ ...good, starters: good.starters.slice(0, 10) },
			ids,
		);
		expect(error(r)).toMatch(/11/);
	});

	it("rejects a duplicate starter", () => {
		const starters = [...good.starters.slice(0, 10), 1];
		expect(error(validateLineup({ ...good, starters }, ids))).toMatch(
			/więcej niż raz/,
		);
	});

	it("rejects a starter outside the squad", () => {
		const starters = [...good.starters.slice(0, 10), 999];
		expect(error(validateLineup({ ...good, starters }, ids))).toMatch(
			/spoza kadry/,
		);
	});

	it("rejects a bench over 9", () => {
		const bench = [...good.bench, 16];
		expect(error(validateLineup({ ...good, bench }, ids))).toMatch(/9/);
	});

	it("rejects a starter on the bench", () => {
		const bench = [...good.bench.slice(0, 8), 1];
		expect(error(validateLineup({ ...good, bench }, ids))).toMatch(
			/jednocześnie/,
		);
	});

	it("rejects bench duplicates and outsiders", () => {
		expect(error(validateLineup({ ...good, bench: [2, 2] }, ids))).toMatch(
			/ławce/,
		);
		expect(error(validateLineup({ ...good, bench: [999] }, ids))).toMatch(
			/spoza kadry/,
		);
	});

	it("rejects an unknown formation and style", () => {
		expect(error(validateLineup({ ...good, formation: "9-1-1" }, ids))).toMatch(
			/formacja/,
		);
		expect(error(validateLineup({ ...good, style: "crazy" }, ids))).toMatch(
			/styl/,
		);
	});

	it("does not treat Object.prototype keys as formations", () => {
		for (const formation of ["toString", "constructor", "__proto__"]) {
			expect(error(validateLineup({ ...good, formation }, ids))).toMatch(
				/formacja/,
			);
		}
	});
});

describe("aiProposal", () => {
	it("gives a valid lineup in slot order with a 9-player bench", () => {
		const p = aiProposal(squad, "4-3-3");
		expect(p.formation).toBe("4-3-3");
		expect(p.style).toBe("balanced");
		expect(p.starters).toHaveLength(11);
		expect(p.bench).toHaveLength(9);
		expect(p.starters[0]).toBe(1); // best goalkeeper first
		expect(validateLineup(p, ids)).toEqual({ ok: true });
	});

	it("bench holds the best remaining by overall", () => {
		const p = aiProposal(squad, "4-4-2");
		const rest = squad
			.filter((x) => !p.starters.includes(x.playerId))
			.sort((a, b) => b.overall - a.overall)
			.slice(0, 9)
			.map((x) => x.playerId);
		expect(p.bench).toEqual(rest);
	});

	it("returns fewer than 11 starters for a tiny squad", () => {
		expect(aiProposal(squad.slice(0, 5), "4-4-2").starters.length).toBeLessThan(
			11,
		);
	});
});

describe("sortSquad", () => {
	it("orders GK, DEF, MID, ATT then overall descending", () => {
		const sorted = sortSquad([...squad].reverse());
		expect(sorted.map((p) => p.position[0])).toEqual(
			squad.map((p) => p.position[0]),
		);
		expect(sorted[0]?.playerId).toBe(1);
		expect(sorted[2]?.playerId).toBe(3);
	});
});
