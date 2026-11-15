// One round of the game with the user's match played live: setup of the live match (AI rival),
// background matches played as in the batch season, and the state after the round.
// Pure module: no imports outside src/engine/ (runs from the CLI for calibration).

import type { PlayerAttributes } from "./attributes";
import {
	aiLiveTeam,
	goalMinutes,
	LIVE_MODEL,
	type LiveModel,
	type LiveSetup,
	type LiveTeam,
	type Side,
} from "./live-match";
import { simulateMatchRatings } from "./match";
import type { PlayerState } from "./player-state";
import type { Rng } from "./rng";
import {
	afterClubMatch,
	pickBestEleven,
	prepareClubRound,
	type SeasonFixture,
} from "./season";
import { DEFAULT_TACTIC, FORMATIONS, type Tactic } from "./tactics";

/** The user's lineup by player id: eleven in slot order of the formation (null = empty slot) and bench. */
export type OwnLineup = {
	tactic: Tactic;
	eleven: (number | null)[];
	bench: number[];
};

export type BackgroundMatch<F extends SeasonFixture = SeasonFixture> = {
	fixture: F;
	homeGoals: number;
	awayGoals: number;
	/** Goal minutes for the live ticker, sorted. */
	goals: { minute: number; side: Side }[];
};

export type PreparedRound<F extends SeasonFixture = SeasonFixture> = {
	round: number;
	/** The user's fixture. */
	fixture: F;
	setup: LiveSetup;
	/** Seed of the live match. */
	seed: number;
	background: BackgroundMatch<F>[];
	/**
	 * State per player of every club that plays the round: background clubs after their match
	 * (whole squad, as in the batch), both clubs of the user's match after beforeRound only (whole
	 * squad; the live outcome then overrides those who played).
	 */
	states: Map<number, PlayerState>;
};

/**
 * Prepares a round: `beforeRound` for every squad player of a playing club, the user's eleven and
 * bench from available players (throws on an unavailable or unknown player; the caller validates
 * first), the rival as AI (best eleven in 4-4-2 balanced, bench of 9). Background fixtures run in
 * input order exactly like a batch round (prepareClubRound -> simulateMatchRatings -> afterClubMatch
 * home then away); goal minutes and the live seed are drawn from `rng` afterwards.
 */
export function prepareRound<F extends SeasonFixture>(
	squads: Map<number, PlayerAttributes[]>,
	states: Map<number, PlayerState>,
	fixtures: F[],
	ownClubId: number,
	ownLineup: OwnLineup | null,
	rng: Rng,
	model: LiveModel = LIVE_MODEL,
): PreparedRound<F> {
	const own = fixtures.find(
		(f) => f.homeClubId === ownClubId || f.awayClubId === ownClubId,
	);
	if (!own) {
		throw new Error(`prepareRound: club ${ownClubId} has no fixture`);
	}
	const round = own.round;
	const next = new Map(states);
	const originals = new Map<number, PlayerAttributes>();
	const background: BackgroundMatch<F>[] = [];
	let setup: LiveSetup | null = null;

	for (const f of fixtures) {
		if (f === own) {
			const teams = [f.homeClubId, f.awayClubId].map((clubId) => {
				const club = prepareClubRound(
					squads.get(clubId) ?? [],
					next,
					round,
					DEFAULT_TACTIC,
					() => [],
					model.state,
				);
				return clubId === ownClubId && ownLineup
					? userTeam(clubId, club.available, ownLineup)
					: aiLiveTeam(clubId, club.available, DEFAULT_TACTIC, model.benchSize);
			});
			const [home, away] = teams as [LiveTeam, LiveTeam];
			const pre: Record<number, PlayerState> = {};
			for (const p of [
				...home.eleven,
				...home.bench,
				...away.eleven,
				...away.bench,
			]) {
				if (!p) continue;
				const s = next.get(p.playerId);
				if (s) pre[p.playerId] = s;
			}
			setup = {
				round,
				userSide: f.homeClubId === ownClubId ? "home" : "away",
				home,
				away,
				states: pre,
			};
			continue;
		}
		const sides = [f.homeClubId, f.awayClubId].map((clubId) => {
			const squad = squads.get(clubId) ?? [];
			for (const p of squad) originals.set(p.playerId, p);
			return prepareClubRound(
				squad,
				next,
				round,
				DEFAULT_TACTIC,
				pickBestEleven,
				model.state,
			);
		});
		const [home, away] = sides as [
			ReturnType<typeof prepareClubRound>,
			ReturnType<typeof prepareClubRound>,
		];
		const { homeGoals, awayGoals } = simulateMatchRatings(
			home.ratings,
			away.ratings,
			rng,
			model.match,
		);
		afterClubMatch(
			home.lineup,
			originals,
			next,
			round,
			homeGoals,
			awayGoals,
			rng,
			model.state,
		);
		afterClubMatch(
			away.lineup,
			originals,
			next,
			round,
			awayGoals,
			homeGoals,
			rng,
			model.state,
		);
		background.push({ fixture: f, homeGoals, awayGoals, goals: [] });
	}
	for (const b of background) {
		b.goals = goalMinutes(b.homeGoals, b.awayGoals, rng);
	}
	const seed = Math.floor(rng() * 2 ** 31);
	if (!setup) throw new Error("prepareRound: own fixture not prepared");
	return { round, fixture: own, setup, seed, background, states: next };
}

function userTeam(
	clubId: number,
	available: PlayerAttributes[],
	lineup: OwnLineup,
): LiveTeam {
	const byId = new Map(available.map((p) => [p.playerId, p]));
	const pick = (id: number): PlayerAttributes => {
		const p = byId.get(id);
		if (!p) {
			throw new Error(`prepareRound: player ${id} is not available`);
		}
		return p;
	};
	const slots = FORMATIONS[lineup.tactic.formation].length;
	const eleven = Array.from({ length: slots }, (_, i) => {
		const id = lineup.eleven[i];
		return id === null || id === undefined ? null : pick(id);
	});
	return {
		clubId,
		tactic: lineup.tactic,
		eleven,
		bench: lineup.bench.map(pick),
	};
}
