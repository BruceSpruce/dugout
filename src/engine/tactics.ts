// Formations, slot roles, play style and the attack/defense ratings of an eleven.
// Pure module: no imports outside src/engine/ (runs from the CLI for calibration).

import type { PlayerAttributes, Position } from "./attributes";

export type Role = "GK" | "DEF" | "DM" | "CM" | "AM" | "ST";

export const ROLE_POSITION: Record<Role, Position> = {
	GK: "Goalkeeper",
	DEF: "Defender",
	DM: "Midfielder",
	CM: "Midfielder",
	AM: "Midfielder",
	ST: "Attacker",
};

export type FormationId =
	| "4-4-2"
	| "4-3-3"
	| "4-2-3-1"
	| "4-5-1"
	| "3-5-2"
	| "3-4-3"
	| "5-3-2";

const roles = (...parts: [Role, number][]): Role[] =>
	parts.flatMap(([role, n]) => Array.from({ length: n }, () => role));

/** Eleven roles per formation in slot order: goalkeeper, defence, midfield, attack. */
export const FORMATIONS: Record<FormationId, Role[]> = {
	"4-4-2": roles(["GK", 1], ["DEF", 4], ["CM", 4], ["ST", 2]),
	"4-3-3": roles(["GK", 1], ["DEF", 4], ["CM", 3], ["ST", 3]),
	"4-2-3-1": roles(["GK", 1], ["DEF", 4], ["DM", 2], ["AM", 3], ["ST", 1]),
	"4-5-1": roles(["GK", 1], ["DEF", 4], ["DM", 1], ["CM", 4], ["ST", 1]),
	"3-5-2": roles(["GK", 1], ["DEF", 3], ["CM", 5], ["ST", 2]),
	"3-4-3": roles(["GK", 1], ["DEF", 3], ["CM", 4], ["ST", 3]),
	"5-3-2": roles(["GK", 1], ["DEF", 5], ["CM", 3], ["ST", 2]),
};

export type Style = "attacking" | "balanced" | "defensive";

export type Tactic = { formation: FormationId; style: Style };

export const DEFAULT_TACTIC: Tactic = { formation: "4-4-2", style: "balanced" };

export type TacticsModel = {
	roleWeights: Record<Role, { attack: number; defense: number }>;
	/** Rating points per unit of role-weight sum relative to 4-4-2 (kappa). */
	formationScale: number;
	/** Points moved between attack and defense by an attacking / defensive style. */
	styleShift: number;
};

/**
 * Role weights sum to 2 per role, so a formation shift is a pure attack <-> defense trade
 * and no formation dominates. kappa 2.5: 4-3-3 and 3-5-2 +1.5 / -1.5, 3-4-3 +3 / -3,
 * 5-3-2 -1.5 / +1.5, 4-5-1 -2.25 / +2.25, 4-2-3-1 0 / 0.
 */
export const TACTICS_MODEL: TacticsModel = {
	roleWeights: {
		GK: { attack: 0, defense: 2 },
		DEF: { attack: 0.4, defense: 1.6 },
		DM: { attack: 0.7, defense: 1.3 },
		CM: { attack: 1, defense: 1 },
		AM: { attack: 1.4, defense: 0.6 },
		ST: { attack: 1.6, defense: 0.4 },
	},
	formationScale: 2.5,
	styleShift: 2,
};

export type Slot = { role: Role; player: PlayerAttributes | null };

const OUT_OF_POSITION_FACTOR = 0.8;
const ELEVEN = 11;

/** Overall of the slot's player; x 0.8 outside the role's position, 0 for an empty slot. */
export function effectiveSlotOverall(slot: Slot): number {
	if (!slot.player) return 0;
	return ROLE_POSITION[slot.role] === slot.player.position
		? slot.player.overall
		: slot.player.overall * OUT_OF_POSITION_FACTOR;
}

const byOverallDesc = (a: PlayerAttributes, b: PlayerAttributes) =>
	b.overall - a.overall || a.playerId - b.playerId;

/**
 * Best eleven for a formation, one slot per formation role in formation order (player null
 * when the squad is too small). Players of the role's position fill first, by overall (ties
 * by playerId). The best N midfielders (N = DM + CM + AM slots) are split by attributes:
 * DM slots take those with the highest `defense`, AM slots the highest `creativity + attack`
 * of the rest, remaining slots are CM (ties by playerId). Gaps are filled with the best
 * remaining outfield players (x 0.8 via effectiveSlotOverall); the GK slot takes only a
 * goalkeeper, else the best remaining outfield player.
 */
export function bestElevenFor(
	squad: PlayerAttributes[],
	formation: FormationId,
): Slot[] {
	const slotRoles = FORMATIONS[formation];
	const sorted = [...squad].sort(byOverallDesc);
	const used = new Set<PlayerAttributes>();
	const take = (position: Position, n: number): PlayerAttributes[] => {
		const picked = sorted
			.filter((p) => p.position === position && !used.has(p))
			.slice(0, n);
		for (const p of picked) used.add(p);
		return picked;
	};
	const count = (role: Role) => slotRoles.filter((r) => r === role).length;

	const byRole = new Map<Role, PlayerAttributes[]>();
	byRole.set("GK", take("Goalkeeper", count("GK")));
	byRole.set("DEF", take("Defender", count("DEF")));
	byRole.set("ST", take("Attacker", count("ST")));

	const nDm = count("DM");
	const nAm = count("AM");
	const mids = take("Midfielder", nDm + count("CM") + nAm);
	const byDefense = [...mids].sort(
		(a, b) => b.defense - a.defense || a.playerId - b.playerId,
	);
	const dms = byDefense.slice(0, nDm);
	const rest = byDefense.slice(nDm);
	const byCreation = [...rest].sort(
		(a, b) =>
			b.creativity + b.attack - (a.creativity + a.attack) ||
			a.playerId - b.playerId,
	);
	const ams = byCreation.slice(0, nAm);
	const cms = byCreation.slice(nAm).sort(byOverallDesc);
	byRole.set("DM", dms);
	byRole.set("AM", ams);
	byRole.set("CM", cms);

	const cursor = new Map<Role, number>();
	const slots: Slot[] = slotRoles.map((role) => {
		const i = cursor.get(role) ?? 0;
		cursor.set(role, i + 1);
		return { role, player: byRole.get(role)?.[i] ?? null };
	});

	const outfield = () =>
		sorted.filter((p) => !used.has(p) && p.position !== "Goalkeeper");
	for (const slot of slots) {
		if (slot.player || slot.role === "GK") continue;
		const filler = outfield()[0];
		if (filler) {
			slot.player = filler;
			used.add(filler);
		}
	}
	const gkSlot = slots.find((s) => s.role === "GK");
	if (gkSlot && !gkSlot.player) {
		const filler = outfield()[0];
		if (filler) {
			gkSlot.player = filler;
			used.add(filler);
		}
	}
	return slots;
}

const STYLE_SIGN: Record<Style, number> = {
	attacking: 1,
	balanced: 0,
	defensive: -1,
};

/**
 * Attack and defense of an eleven: quality is the role-weighted mean of effective overalls
 * over filled slots, plus the formation shift (from the formation's full role list, independent
 * of fill) and the style shift; both are then multiplied by filled / 11.
 */
export function teamRatings(
	slots: Slot[],
	tactic: Tactic,
	model: TacticsModel = TACTICS_MODEL,
): { attack: number; defense: number } {
	const filled = slots.filter((s) => s.player);
	const weightedMean = (key: "attack" | "defense") => {
		let sum = 0;
		let weights = 0;
		for (const s of filled) {
			const w = model.roleWeights[s.role][key];
			sum += w * effectiveSlotOverall(s);
			weights += w;
		}
		return weights > 0 ? sum / weights : 0;
	};
	const weightSum = (formation: FormationId, key: "attack" | "defense") =>
		FORMATIONS[formation].reduce((s, r) => s + model.roleWeights[r][key], 0);
	const formationShift = (key: "attack" | "defense") =>
		model.formationScale *
		(weightSum(tactic.formation, key) -
			weightSum(DEFAULT_TACTIC.formation, key));
	const style = STYLE_SIGN[tactic.style] * model.styleShift;
	const factor = filled.length / ELEVEN;
	return {
		attack:
			(weightedMean("attack") + formationShift("attack") + style) * factor,
		defense:
			(weightedMean("defense") + formationShift("defense") - style) * factor,
	};
}
