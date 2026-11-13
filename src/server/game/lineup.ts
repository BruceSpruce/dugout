// Lineup logic for the squad screen: `validateLineup` and `aiProposal` are pure, `loadClubSquad`
// is the thin DB layer (attributes of the game's club for the game's season).

import { sql } from "drizzle-orm";

import { computeAttributes, type PlayerAttributes } from "~/engine/attributes";
import {
	bestElevenFor,
	FORMATIONS,
	type FormationId,
	type Style,
} from "~/engine/tactics";
import type { Db } from "~/import/api-football/load";
import { loadAttributesInput } from "~/server/engine-input/attributes-input";

export const FORMATION_IDS = Object.keys(FORMATIONS) as [
	FormationId,
	...FormationId[],
];
export const STYLE_IDS = [
	"attacking",
	"balanced",
	"defensive",
] as const satisfies readonly Style[];

const STARTERS = 11;
const MAX_BENCH = 9;

export type LineupInput = {
	formation: string;
	style: string;
	starters: number[];
	bench: number[];
};

export type LineupProposal = {
	formation: FormationId;
	style: Style;
	starters: number[];
	bench: number[];
};

export type LineupValidation = { ok: true } | { ok: false; error: string };

const hasDuplicates = (ids: number[]) => new Set(ids).size !== ids.length;

export function validateLineup(
	input: LineupInput,
	squadIds: Set<number>,
): LineupValidation {
	const fail = (error: string): LineupValidation => ({ ok: false, error });
	if (!Object.hasOwn(FORMATIONS, input.formation))
		return fail("Nieznana formacja");
	if (!(STYLE_IDS as readonly string[]).includes(input.style)) {
		return fail("Nieznany styl gry");
	}
	if (input.starters.length !== STARTERS) {
		return fail("W składzie musi być dokładnie 11 zawodników");
	}
	if (hasDuplicates(input.starters)) {
		return fail("Ten sam zawodnik występuje w składzie więcej niż raz");
	}
	if (input.starters.some((id) => !squadIds.has(id))) {
		return fail("W składzie jest zawodnik spoza kadry klubu");
	}
	if (input.bench.length > MAX_BENCH) {
		return fail("Na ławce może być najwyżej 9 zawodników");
	}
	if (hasDuplicates(input.bench)) {
		return fail("Ten sam zawodnik występuje na ławce więcej niż raz");
	}
	if (input.bench.some((id) => !squadIds.has(id))) {
		return fail("Na ławce jest zawodnik spoza kadry klubu");
	}
	const starters = new Set(input.starters);
	if (input.bench.some((id) => starters.has(id))) {
		return fail("Zawodnik nie może być jednocześnie w składzie i na ławce");
	}
	return { ok: true };
}

const POSITION_ORDER: Record<PlayerAttributes["position"], number> = {
	Goalkeeper: 0,
	Defender: 1,
	Midfielder: 2,
	Attacker: 3,
};

/** UI order: Goalkeeper, Defender, Midfielder, Attacker, then overall descending. */
export function sortSquad(squad: PlayerAttributes[]): PlayerAttributes[] {
	return [...squad].sort(
		(a, b) =>
			POSITION_ORDER[a.position] - POSITION_ORDER[b.position] ||
			b.overall - a.overall ||
			a.playerId - b.playerId,
	);
}

/**
 * AI lineup for a formation: starters in slot order (best eleven), bench of the 9 best remaining
 * by overall. With a squad too small to fill 11 slots the starters list is short, which
 * validateLineup rejects (PL squads always fill).
 */
export function aiProposal(
	squad: PlayerAttributes[],
	formation: FormationId,
): LineupProposal {
	const starters = bestElevenFor(squad, formation).flatMap((s) =>
		s.player ? [s.player.playerId] : [],
	);
	const taken = new Set(starters);
	const bench = squad
		.filter((p) => !taken.has(p.playerId))
		.sort((a, b) => b.overall - a.overall || a.playerId - b.playerId)
		.slice(0, MAX_BENCH)
		.map((p) => p.playerId);
	return { formation, style: "balanced", starters, bench };
}

/** Null when the game does not exist or its season is not loaded. */
export async function loadClubSquad(
	db: Db,
	gameId: number,
): Promise<{
	game: { clubId: number; currentRound: number };
	squad: PlayerAttributes[];
} | null> {
	const rows = await db.execute<{
		club_id: number;
		current_round: number;
		league_api_id: number;
		season: number;
	}>(
		sql`select g.club_id, g.current_round, cs.league_api_id, cs.season
			from dugout_game g join dugout_competition_season cs on cs.id = g.competition_season_id
			where g.id = ${gameId}`,
	);
	const g = rows[0];
	if (!g) return null;
	const input = await loadAttributesInput(db, g.league_api_id, g.season);
	if (!input) return null;
	const squad = computeAttributes(input.players).filter(
		(p) => p.clubId === g.club_id,
	);
	return {
		game: { clubId: g.club_id, currentRound: g.current_round },
		squad,
	};
}
