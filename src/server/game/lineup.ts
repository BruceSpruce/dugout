// Lineup logic for the squad screen: `validateLineup`, `aiProposal` and the availability helpers
// are pure; `loadClubSquad` / `loadPlayerStates` are the thin DB layer (attributes of the game's
// club for the game's season, stored player state of the game).

import { sql } from "drizzle-orm";

import { computeAttributes, type PlayerAttributes } from "~/engine/attributes";
import {
	beforeRound,
	effectiveOverall,
	freshState,
	type PlayerState,
} from "~/engine/player-state";
import {
	bestElevenFor,
	FORMATIONS,
	type FormationId,
	type Style,
} from "~/engine/tactics";
import type { Db } from "~/import/api-football/load";
import { type AppErrorData, appError } from "~/server/app-error";
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

export type LineupValidation =
	| { ok: true }
	| { ok: false; error: AppErrorData };

const hasDuplicates = (ids: number[]) => new Set(ids).size !== ids.length;

export function validateLineup(
	input: LineupInput,
	squadIds: Set<number>,
): LineupValidation {
	const fail = (error: AppErrorData): LineupValidation => ({
		ok: false,
		error,
	});
	if (!Object.hasOwn(FORMATIONS, input.formation))
		return fail(appError("unknownFormation"));
	if (!(STYLE_IDS as readonly string[]).includes(input.style)) {
		return fail(appError("unknownStyle"));
	}
	if (input.starters.length !== STARTERS) {
		return fail(appError("lineupSize", { n: STARTERS }));
	}
	if (hasDuplicates(input.starters)) {
		return fail(appError("starterDuplicate"));
	}
	if (input.starters.some((id) => !squadIds.has(id))) {
		return fail(appError("starterNotInSquad"));
	}
	if (input.bench.length > MAX_BENCH) {
		return fail(appError("benchSize", { max: MAX_BENCH }));
	}
	if (hasDuplicates(input.bench)) {
		return fail(appError("benchDuplicate"));
	}
	if (input.bench.some((id) => !squadIds.has(id))) {
		return fail(appError("benchNotInSquad"));
	}
	const starters = new Set(input.starters);
	if (input.bench.some((id) => starters.has(id))) {
		return fail(appError("starterOnBench"));
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

/** Player state for the squad screen: kickoff fitness of the coming round, matches still to miss. */
export type PlayerStatus = {
	/** Fitness at the next kickoff (stored fitness + recovery before the round), 0-100. */
	fitness: number;
	form: number;
	/** Club matches still to miss (the coming one included). */
	injuredFor: number;
	suspendedFor: number;
	available: boolean;
	/** Overall for the coming round (fitness and form applied), one decimal. */
	effectiveOverall: number;
};

const round1 = (x: number) => Math.round(x * 10) / 10;

/**
 * The squad as it enters the coming round: `beforeRound` on the stored state (missing =
 * freshState), availability judged on the stored state, effectiveOverall on the recovered state
 * — the same rules as prepareRound / the batch season.
 */
export function squadForRound(
	squad: PlayerAttributes[],
	states: Map<number, PlayerState>,
): {
	/** Every squad player with its status (base attributes unchanged). */
	withStatus: (PlayerAttributes & { status: PlayerStatus })[];
	/** Available players only, overall = effectiveOverall (input for aiProposal / teamRatings). */
	available: PlayerAttributes[];
	/** Every squad player with overall = effectiveOverall (for ratings of any lineup). */
	effective: PlayerAttributes[];
} {
	const withStatus: (PlayerAttributes & { status: PlayerStatus })[] = [];
	const available: PlayerAttributes[] = [];
	const effective: PlayerAttributes[] = [];
	for (const p of squad) {
		const stored = states.get(p.playerId) ?? freshState();
		const { state, available: ok } = beforeRound(stored, true);
		const overall = effectiveOverall(p, state);
		withStatus.push({
			...p,
			status: {
				fitness: round1(state.fitness),
				form: Math.round(state.form * 100) / 100,
				injuredFor: stored.injuredFor,
				suspendedFor: stored.suspendedFor,
				available: ok,
				effectiveOverall: round1(overall),
			},
		});
		effective.push({ ...p, overall });
		if (ok) available.push({ ...p, overall });
	}
	return { withStatus, available, effective };
}

/** Why a player misses the coming round: injury or suspension, matches still to miss. */
export type UnavailableReason = {
	kind: "injury" | "suspension";
	matches: number;
};

/** Why a player cannot play the coming round (injury first), null when available. */
export function unavailableReason(
	stored: PlayerState | undefined,
): UnavailableReason | null {
	const s = stored ?? freshState();
	if (s.injuredFor > 0) return { kind: "injury", matches: s.injuredFor };
	if (s.suspendedFor > 0) {
		return { kind: "suspension", matches: s.suspendedFor };
	}
	return null;
}

/** Rejects injured or suspended starters and bench players (first one found, starters first). */
export function validateAvailability(
	lineup: { starters: number[]; bench: number[] },
	squad: PlayerAttributes[],
	states: Map<number, PlayerState>,
): LineupValidation {
	const byId = new Map(squad.map((p) => [p.playerId, p]));
	for (const id of [...lineup.starters, ...lineup.bench]) {
		const reason = unavailableReason(states.get(id));
		if (reason) {
			return {
				ok: false,
				error: appError("playerUnavailable", {
					where: lineup.starters.includes(id) ? "starters" : "bench",
					name: byId.get(id)?.name ?? `#${id}`,
					reason: appError(
						reason.kind === "injury"
							? "unavailableInjury"
							: "unavailableSuspension",
						{ n: reason.matches },
					),
				}),
			};
		}
	}
	return { ok: true };
}

/** Stored player state of a game (players without a row are fresh). */
export async function loadPlayerStates(
	db: Db,
	gameId: number,
): Promise<Map<number, PlayerState>> {
	const rows = await db.execute<{
		player_id: number;
		fitness: number;
		form: number;
		yellow_count: number;
		suspended_for: number;
		injured_for: number;
	}>(
		sql`select player_id, fitness, form, yellow_count, suspended_for, injured_for
			from dugout_game_player_state where game_id = ${gameId}`,
	);
	return new Map(
		rows.map((r) => [
			r.player_id,
			{
				fitness: Number(r.fitness),
				form: Number(r.form),
				yellowCount: r.yellow_count,
				suspendedFor: r.suspended_for,
				injuredFor: r.injured_for,
			},
		]),
	);
}

/** Null when the game does not exist or its season is not loaded. */
export async function loadClubSquad(
	db: Db,
	gameId: number,
): Promise<{
	game: { clubId: number; currentRound: number };
	squad: PlayerAttributes[];
	states: Map<number, PlayerState>;
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
		states: await loadPlayerStates(db, gameId),
	};
}
