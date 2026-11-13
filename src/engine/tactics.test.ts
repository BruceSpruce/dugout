import { describe, expect, it } from "vitest";
import type { PlayerAttributes, Position } from "./attributes";
import {
	bestElevenFor,
	DEFAULT_TACTIC,
	effectiveSlotOverall,
	FORMATIONS,
	type FormationId,
	ROLE_POSITION,
	type Slot,
	type Style,
	teamRatings,
} from "./tactics";

let nextId = 1;
const player = (
	position: Position,
	overall: number,
	extra: Partial<PlayerAttributes> = {},
): PlayerAttributes => ({
	playerId: nextId++,
	name: `P${nextId}`,
	clubId: 1,
	position,
	minutes: 2000,
	attack: 50,
	creativity: 50,
	defense: 50,
	goalkeeping: 50,
	discipline: 50,
	overall,
	...extra,
});

const squad = (overall = 70): PlayerAttributes[] => [
	...Array.from({ length: 2 }, () => player("Goalkeeper", overall)),
	...Array.from({ length: 6 }, () => player("Defender", overall)),
	...Array.from({ length: 7 }, () => player("Midfielder", overall)),
	...Array.from({ length: 4 }, () => player("Attacker", overall)),
];

const ids = Object.keys(FORMATIONS) as FormationId[];
const ratings = (
	s: PlayerAttributes[],
	formation: FormationId,
	style: Style = "balanced",
) => teamRatings(bestElevenFor(s, formation), { formation, style });

describe("FORMATIONS", () => {
	it("(a) every formation has 11 slots with GK first", () => {
		for (const id of ids) {
			expect(FORMATIONS[id]).toHaveLength(11);
			expect(FORMATIONS[id][0]).toBe("GK");
			expect(bestElevenFor(squad(), id)).toHaveLength(11);
		}
	});
});

describe("teamRatings", () => {
	it("(b) 4-2-3-1 and 4-5-1 differ for the same squad", () => {
		const s = squad();
		const a = ratings(s, "4-2-3-1");
		const b = ratings(s, "4-5-1");
		expect(a.attack).not.toBeCloseTo(b.attack, 6);
		expect(a.defense).not.toBeCloseTo(b.defense, 6);
	});

	it("(c) equal overalls: 4-4-2 balanced is overall; 4-3-3 > 4-4-2 > 5-3-2 in attack, reverse in defense", () => {
		const s = squad(70);
		const base = ratings(s, "4-4-2");
		expect(base.attack).toBeCloseTo(70, 9);
		expect(base.defense).toBeCloseTo(70, 9);
		const off = ratings(s, "4-3-3");
		const def = ratings(s, "5-3-2");
		expect(off.attack).toBeGreaterThan(base.attack);
		expect(base.attack).toBeGreaterThan(def.attack);
		expect(off.defense).toBeLessThan(base.defense);
		expect(base.defense).toBeLessThan(def.defense);
	});

	it("(d) attacking style is +2 / -2 and defensive -2 / +2 against balanced", () => {
		const s = squad();
		const bal = ratings(s, "4-4-2", "balanced");
		const att = ratings(s, "4-4-2", "attacking");
		const def = ratings(s, "4-4-2", "defensive");
		expect(att.attack - bal.attack).toBeCloseTo(2, 9);
		expect(att.defense - bal.defense).toBeCloseTo(-2, 9);
		expect(def.attack - bal.attack).toBeCloseTo(-2, 9);
		expect(def.defense - bal.defense).toBeCloseTo(2, 9);
	});

	it("(e) out-of-position player counts x 0.8 and an empty slot scales by n/11", () => {
		const gk = player("Goalkeeper", 100);
		expect(effectiveSlotOverall({ role: "GK", player: gk })).toBe(100);
		expect(
			effectiveSlotOverall({ role: "ST", player: player("Defender", 50) }),
		).toBeCloseTo(40, 9);
		expect(effectiveSlotOverall({ role: "ST", player: null })).toBe(0);

		const full = bestElevenFor(squad(70), "4-4-2");
		const missing: Slot[] = full.map((s, i) =>
			i === 10 ? { ...s, player: null } : s,
		);
		const r = teamRatings(missing, DEFAULT_TACTIC);
		expect(r.attack).toBeCloseTo((70 * 10) / 11, 9);
		expect(r.defense).toBeCloseTo((70 * 10) / 11, 9);
	});

	it("(k) formation attack shift is the negative of the defense shift", () => {
		const s = squad(70);
		const base = ratings(s, "4-4-2");
		for (const id of ids) {
			const r = ratings(s, id);
			expect(r.attack - base.attack).toBeCloseTo(
				-(r.defense - base.defense),
				9,
			);
		}
	});

	it("keeps formation shifts independent of how many slots are filled", () => {
		const s = squad(70);
		const slots = bestElevenFor(s, "4-3-3").map((x, i) =>
			i === 10 ? { ...x, player: null } : x,
		);
		const r = teamRatings(slots, { formation: "4-3-3", style: "balanced" });
		expect(r.attack).toBeCloseTo(((70 + 2.4) * 10) / 11, 9);
		expect(r.defense).toBeCloseTo(((70 - 2.4) * 10) / 11, 9);
	});
});

describe("bestElevenFor", () => {
	it("(f) uses nobody twice and puts a goalkeeper in the GK slot", () => {
		const s = squad();
		for (const id of ids) {
			const slots = bestElevenFor(s, id);
			const got = slots.map((x) => x.player?.playerId);
			expect(new Set(got).size).toBe(11);
			expect(slots[0]?.player?.position).toBe("Goalkeeper");
		}
	});

	it("assigns midfielders to DM by defense and AM by creativity + attack", () => {
		const mids = [
			player("Midfielder", 80, { defense: 90, creativity: 10, attack: 10 }),
			player("Midfielder", 79, { defense: 85, creativity: 10, attack: 10 }),
			player("Midfielder", 78, { defense: 20, creativity: 90, attack: 80 }),
			player("Midfielder", 77, { defense: 20, creativity: 80, attack: 80 }),
			player("Midfielder", 76, { defense: 20, creativity: 70, attack: 80 }),
		];
		const s = [...squad().filter((p) => p.position !== "Midfielder"), ...mids];
		const slots = bestElevenFor(s, "4-2-3-1");
		const at = (role: string) =>
			slots.filter((x) => x.role === role).map((x) => x.player?.playerId);
		expect(at("DM")).toEqual([mids[0]?.playerId, mids[1]?.playerId]);
		expect(new Set(at("AM"))).toEqual(
			new Set([mids[2], mids[3], mids[4]].map((m) => m?.playerId)),
		);
	});

	it("fills gaps with outfield players x 0.8; GK slot only by a goalkeeper, else outfield", () => {
		const noMids = squad().filter((p) => p.position !== "Midfielder");
		const slots = bestElevenFor(noMids, "4-4-2");
		const cm = slots.filter((x) => x.role === "CM");
		expect(
			cm.every((x) => x.player && x.player.position !== "Goalkeeper"),
		).toBe(true);
		expect(effectiveSlotOverall(cm[0] as Slot)).toBeCloseTo(56, 9);

		const noGk = squad().filter((p) => p.position !== "Goalkeeper");
		const gk = bestElevenFor(noGk, "4-4-2")[0];
		expect(gk?.player).not.toBeNull();
		expect(gk?.player?.position).not.toBe("Goalkeeper");
		expect(effectiveSlotOverall(gk as Slot)).toBeCloseTo(56, 9);
	});

	it("returns null slots when the squad is too small", () => {
		const slots = bestElevenFor(squad().slice(0, 8), "4-4-2");
		expect(slots).toHaveLength(11);
		expect(slots.filter((x) => x.player === null)).toHaveLength(4);
	});

	it("ROLE_POSITION maps roles to positions", () => {
		expect(ROLE_POSITION.AM).toBe("Midfielder");
		expect(ROLE_POSITION.ST).toBe("Attacker");
	});
});
