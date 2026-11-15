// Round flow of a game with the user's match played live: pure functions, no DB. `startRound`
// builds the game_live_match row, `advanceMatch` / `applyChange` compute its next state,
// `matchView` is what the match screen shows, `finishRound` is what the end of the round writes.
// The SQL layer is load-match.ts.

import type { PlayerAttributes } from "~/engine/attributes";
import { leagueTable, type TableRow } from "~/engine/club-strength";
import {
	FULL_TIME,
	injuryAutoSubs,
	type LiveChange,
	type LiveEventKind,
	type LiveSetup,
	type LiveSideView,
	playLive,
	type Side,
	validateChange,
} from "~/engine/live-match";
import { type OwnLineup, prepareRound } from "~/engine/live-round";
import type { PlayerState, RedCard } from "~/engine/player-state";
import { createRng } from "~/engine/rng";
import type { FormationId, Role, Style, Tactic } from "~/engine/tactics";
import {
	type LineupInput,
	validateAvailability,
	validateLineup,
} from "./lineup";

export type FlowFixture = {
	fixtureId: number;
	round: number;
	homeClubId: number;
	awayClubId: number;
};

export type StoredBackgroundMatch = {
	fixtureId: number;
	homeClubId: number;
	awayClubId: number;
	homeGoals: number;
	awayGoals: number;
	goals: { minute: number; side: Side }[];
};

/** game_live_match.background: the other matches of the round and the state after the round. */
export type StoredBackground = {
	matches: StoredBackgroundMatch[];
	/**
	 * State per player of every squad of a club that plays the round: background clubs after
	 * their match, both clubs of the user's match after beforeRound only (the live outcome
	 * overrides those who played).
	 */
	states: { playerId: number; state: PlayerState }[];
};

export type LiveStatus = "live" | "finished";

export type LiveMatchRow = {
	gameId: number;
	fixtureId: number;
	round: number;
	seed: number;
	setup: LiveSetup;
	background: StoredBackground;
	changes: LiveChange[];
	minute: number;
	status: LiveStatus;
};

export type FlowResult<T> = ({ ok: true } & T) | { ok: false; error: string };

const fail = (error: string): { ok: false; error: string } => ({
	ok: false,
	error,
});

// --- start ------------------------------------------------------------------------------------

export type StartInput = {
	gameId: number;
	clubId: number;
	currentRound: number;
	/** Fixtures of the season (or only of the current round). */
	fixtures: FlowFixture[];
	/** Squad per club (base attributes). */
	squads: Map<number, PlayerAttributes[]>;
	/** Stored player state of the game; missing = freshState. */
	states: Map<number, PlayerState>;
	/** Saved lineup of the game; null = AI proposal from available players. */
	lineup: LineupInput | null;
	/** Status of the existing game_live_match row, null when none. */
	existing: LiveStatus | null;
	/** Seed of the round (background matches, live seed). */
	seed: number;
};

export const MATCH_IN_PROGRESS = "Mecz już trwa.";

/**
 * Prepares the round: the user's match setup (saved lineup or AI from available players, the
 * rival as AI), the background matches already played, and the state after the round of every
 * squad player of the clubs that play. Errors in Polish.
 */
export function startRound(
	input: StartInput,
): FlowResult<{ row: LiveMatchRow }> {
	if (input.existing === "live") return fail(MATCH_IN_PROGRESS);
	const fixtures = input.fixtures
		.filter((f) => f.round === input.currentRound)
		.sort((a, b) => a.fixtureId - b.fixtureId);
	const own = fixtures.find(
		(f) => f.homeClubId === input.clubId || f.awayClubId === input.clubId,
	);
	if (!own) return fail("Twój klub nie ma meczu w bieżącej kolejce.");

	const squad = input.squads.get(input.clubId) ?? [];
	let ownLineup: OwnLineup | null = null;
	if (input.lineup) {
		const checked = validateLineup(
			input.lineup,
			new Set(squad.map((p) => p.playerId)),
		);
		if (!checked.ok) return fail(`Zapisany skład: ${checked.error}`);
		const available = validateAvailability(input.lineup, squad, input.states);
		if (!available.ok) return available;
		ownLineup = {
			tactic: {
				formation: input.lineup.formation as FormationId,
				style: input.lineup.style as Style,
			},
			eleven: input.lineup.starters,
			bench: input.lineup.bench,
		};
	}

	const prepared = prepareRound(
		input.squads,
		input.states,
		fixtures,
		input.clubId,
		ownLineup,
		createRng(input.seed),
	);

	const states: StoredBackground["states"] = [];
	for (const f of fixtures) {
		for (const clubId of [f.homeClubId, f.awayClubId]) {
			for (const p of input.squads.get(clubId) ?? []) {
				const state = prepared.states.get(p.playerId);
				if (state) states.push({ playerId: p.playerId, state });
			}
		}
	}

	return {
		ok: true,
		row: {
			gameId: input.gameId,
			fixtureId: own.fixtureId,
			round: prepared.round,
			seed: prepared.seed,
			setup: prepared.setup,
			background: {
				matches: prepared.background.map((b) => ({
					fixtureId: b.fixture.fixtureId,
					homeClubId: b.fixture.homeClubId,
					awayClubId: b.fixture.awayClubId,
					homeGoals: b.homeGoals,
					awayGoals: b.awayGoals,
					goals: b.goals,
				})),
				states,
			},
			changes: [],
			minute: 0,
			status: "live",
		},
	};
}

// --- advance / change -------------------------------------------------------------------------

const NOT_LIVE = "Mecz nie trwa.";

/**
 * Moves the match clock forward only (an earlier minute keeps the current one), max 90, and
 * appends explicit AI substitutions for the user's injured players left unreplaced (F5/F12).
 */
export function advanceMatch(
	row: Pick<LiveMatchRow, "setup" | "seed" | "changes" | "minute" | "status">,
	toMinute: number,
): FlowResult<{ minute: number; changes: LiveChange[] }> {
	if (row.status !== "live") return fail(NOT_LIVE);
	const minute = Math.min(
		FULL_TIME,
		Math.max(row.minute, Math.floor(toMinute)),
	);
	const changes = injuryAutoSubs(row.setup, row.seed, row.changes, minute);
	return { ok: true, minute, changes };
}

export type PlayerChange =
	| { kind: "sub"; out: number; in: number }
	| { kind: "tactic"; formation: FormationId; style: Style };

/** The user's change at the current server minute (F6), validated by the engine. */
export function applyChange(
	row: Pick<LiveMatchRow, "setup" | "seed" | "changes" | "minute" | "status">,
	change: PlayerChange,
): FlowResult<{ changes: LiveChange[] }> {
	if (row.status !== "live") return fail(NOT_LIVE);
	const full: LiveChange =
		change.kind === "sub"
			? {
					minute: row.minute,
					by: "player",
					kind: "sub",
					out: change.out,
					in: change.in,
				}
			: {
					minute: row.minute,
					by: "player",
					kind: "tactic",
					formation: change.formation,
					style: change.style,
				};
	const checked = validateChange(row.setup, row.seed, row.changes, full);
	if (!checked.ok) return checked;
	return { ok: true, changes: [...row.changes, full] };
}

// --- view -------------------------------------------------------------------------------------

export type ClubName = { clubId: number; name: string };

/** A game result of an earlier round (game_result joined with its fixture). */
export type PlayedResult = {
	fixtureId: number;
	homeClubId: number;
	awayClubId: number;
	homeGoals: number;
	awayGoals: number;
};

export type MatchViewEvent = {
	minute: number;
	side: Side | null;
	kind: LiveEventKind;
	playerId: number | null;
	playerName: string | null;
	inPlayerId?: number;
	inPlayerName?: string;
	by?: "player" | "ai";
	formation?: FormationId;
	style?: Style;
};

export type MatchViewPlayer = {
	playerId: number;
	name: string;
	position: PlayerAttributes["position"];
	/** Pre-match overall (effectiveOverall), one decimal. */
	overall: number;
	/** Pre-match fitness 0-100. */
	fitness: number;
};

export type MatchViewSide = {
	clubId: number;
	name: string;
	tactic: Tactic;
	subsLeft: number;
	/** Slots in formation order; value = current value on the pitch (fatigue applied). */
	slots: {
		role: Role;
		player: MatchViewPlayer | null;
		value: number;
		/** Current value / pre-match overall, 0-100 (in-match condition). */
		condition: number | null;
	}[];
	/** Bench players still able to come on. */
	bench: MatchViewPlayer[];
	/** Injured players whose slot is still empty. */
	vacancies: number[];
	lambda: number;
};

export type MatchView = {
	gameId: number;
	round: number;
	fixtureId: number;
	minute: number;
	status: LiveStatus;
	finished: boolean;
	userSide: Side | null;
	score: { home: number; away: number };
	home: MatchViewSide;
	away: MatchViewSide;
	/** Newest first. */
	events: MatchViewEvent[];
	/** Other matches of the round with the score at the current minute. */
	others: {
		fixtureId: number;
		home: ClubName;
		away: ClubName;
		homeGoals: number;
		awayGoals: number;
		/** Goals up to the current minute, oldest first. */
		goals: { minute: number; side: Side }[];
	}[];
	/** Live table: earlier rounds plus the current scores of this round. */
	table: TableRow[];
};

const round1 = (x: number) => Math.round(x * 10) / 10;

/** The match screen at the row's minute: pure replay, no side effects. */
export function matchView(
	row: LiveMatchRow,
	clubs: ClubName[],
	results: PlayedResult[],
): MatchView {
	const names = new Map(clubs.map((c) => [c.clubId, c.name]));
	const club = (clubId: number): ClubName => ({
		clubId,
		name: names.get(clubId) ?? `#${clubId}`,
	});
	const live = playLive(row.setup, row.seed, row.changes, row.minute);

	const players = new Map<number, PlayerAttributes>();
	for (const team of [row.setup.home, row.setup.away]) {
		for (const p of [...team.eleven, ...team.bench]) {
			if (p) players.set(p.playerId, p);
		}
	}
	const viewPlayer = (id: number): MatchViewPlayer | null => {
		const p = players.get(id);
		if (!p) return null;
		return {
			playerId: id,
			name: p.name,
			position: p.position,
			overall: round1(p.overall),
			fitness: round1(row.setup.states[id]?.fitness ?? 100),
		};
	};
	const nameOf = (id: number | null | undefined) =>
		id === null || id === undefined
			? null
			: (players.get(id)?.name ?? `#${id}`);

	const side = (s: Side): MatchViewSide => {
		const team = row.setup[s];
		const v: LiveSideView = live.sides[s];
		return {
			...club(team.clubId),
			tactic: v.tactic,
			subsLeft: v.subsLeft,
			slots: v.slots.map((slot) => {
				const player =
					slot.playerId === null ? null : viewPlayer(slot.playerId);
				const base = player ? players.get(player.playerId)?.overall : undefined;
				return {
					role: slot.role,
					player,
					value: round1(slot.value),
					condition:
						base && base > 0
							? Math.round(Math.min(100, (100 * slot.value) / base))
							: null,
				};
			}),
			bench: v.bench.flatMap((id) => {
				const p = viewPlayer(id);
				return p ? [p] : [];
			}),
			vacancies: v.vacancies,
			lambda: Math.round(v.lambda * 100) / 100,
		};
	};

	const others = row.background.matches.map((m) => {
		const goals = m.goals.filter((g) => g.minute <= live.minute);
		return {
			fixtureId: m.fixtureId,
			home: club(m.homeClubId),
			away: club(m.awayClubId),
			homeGoals: goals.filter((g) => g.side === "home").length,
			awayGoals: goals.filter((g) => g.side === "away").length,
			goals,
		};
	});

	const roundFixtures = new Set([
		row.fixtureId,
		...row.background.matches.map((m) => m.fixtureId),
	]);
	const table = leagueTable(
		[
			...results.filter((r) => !roundFixtures.has(r.fixtureId)),
			...others.map((o) => ({
				homeClubId: o.home.clubId,
				awayClubId: o.away.clubId,
				homeGoals: o.homeGoals,
				awayGoals: o.awayGoals,
			})),
			{
				homeClubId: row.setup.home.clubId,
				awayClubId: row.setup.away.clubId,
				homeGoals: live.score.home,
				awayGoals: live.score.away,
			},
		],
		clubs,
	);

	return {
		gameId: row.gameId,
		round: row.round,
		fixtureId: row.fixtureId,
		minute: live.minute,
		status: row.status,
		finished: live.finished,
		userSide: row.setup.userSide,
		score: live.score,
		home: side("home"),
		away: side("away"),
		events: live.events
			.map((e) => ({
				minute: e.minute,
				side: e.side,
				kind: e.kind,
				playerId: e.playerId,
				playerName: nameOf(e.playerId),
				...(e.inPlayerId !== undefined
					? {
							inPlayerId: e.inPlayerId,
							inPlayerName: nameOf(e.inPlayerId) ?? `#${e.inPlayerId}`,
						}
					: {}),
				...(e.by ? { by: e.by } : {}),
				...(e.formation ? { formation: e.formation } : {}),
				...(e.style ? { style: e.style } : {}),
			}))
			.reverse(),
		others,
		table,
	};
}

// --- finish -----------------------------------------------------------------------------------

export type RoundFinish = {
	/** Every match of the round, the user's first. */
	results: { fixtureId: number; homeGoals: number; awayGoals: number }[];
	/** State of every squad player of the clubs that played (live outcome over the background state). */
	states: { playerId: number; state: PlayerState }[];
	/** Per player of the user's match who played: cards and injury (for logs/tests). */
	played: {
		playerId: number;
		minutes: number;
		yellow: boolean;
		red: RedCard;
		injured: number;
	}[];
	nextRound: number;
};

/** What the end of the round writes; only at minute 90. */
export function finishRound(row: LiveMatchRow): FlowResult<RoundFinish> {
	if (row.minute < FULL_TIME) return fail("Mecz jeszcze trwa.");
	const live = playLive(row.setup, row.seed, row.changes, FULL_TIME);
	const outcome = live.outcome;
	if (!outcome) return fail("Mecz jeszcze trwa.");

	const states = new Map(
		row.background.states.map((s) => [s.playerId, s.state]),
	);
	for (const p of outcome.players) states.set(p.playerId, p.state);

	return {
		ok: true,
		results: [
			{
				fixtureId: row.fixtureId,
				homeGoals: live.score.home,
				awayGoals: live.score.away,
			},
			...row.background.matches.map((m) => ({
				fixtureId: m.fixtureId,
				homeGoals: m.homeGoals,
				awayGoals: m.awayGoals,
			})),
		],
		states: [...states].map(([playerId, state]) => ({ playerId, state })),
		played: outcome.players.map((p) => ({
			playerId: p.playerId,
			minutes: p.minutes,
			yellow: p.yellow,
			red: p.red,
			injured: p.injured,
		})),
		nextRound: row.round + 1,
	};
}
