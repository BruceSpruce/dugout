// Round screen model: pure function, no DB. Uses only the game's own results.

import { leagueTable, type TableRow } from "~/engine/club-strength";
import type { LiveChange } from "~/engine/live-match";
import { aiTakeover, type LiveStatus } from "./match-flow";

export type RoundScreenInput = {
	clubId: number;
	/** Current season of the game; `results` are of this season only. */
	seasonNo: number;
	currentRound: number;
	totalRounds: number;
	clubs: { clubId: number; name: string }[];
	fixtures: {
		fixtureId: number;
		round: number;
		kickoffAt: Date;
		homeClubId: number;
		awayClubId: number;
	}[];
	results: { fixtureId: number; homeGoals: number; awayGoals: number }[];
	/** The game's game_live_match row (only what the screen needs); null when none. */
	liveMatch: {
		status: LiveStatus;
		seasonNo: number;
		round: number;
		fixtureId: number;
		changes: LiveChange[];
		/** Game result of the row's fixture in the row's season; null when not written. */
		result: { homeGoals: number; awayGoals: number } | null;
	} | null;
};

export type RoundScreen = {
	clubId: number;
	clubName: string;
	round: number;
	totalRounds: number;
	nextMatch: {
		fixtureId: number;
		opponent: string;
		home: boolean;
		kickoffAt: Date;
		round: number;
	} | null;
	table: TableRow[];
	previousRound: {
		round: number;
		matches: {
			home: string;
			away: string;
			homeGoals: number;
			awayGoals: number;
		}[];
	} | null;
	/** The user's match of the previous round was played out by the AI (exit or abandoned). */
	aiFinished: {
		home: string;
		away: string;
		score: { home: number; away: number };
		fromMinute: number;
	} | null;
};

export function buildRoundScreen(input: RoundScreenInput): RoundScreen {
	const { clubId, currentRound, totalRounds, clubs, fixtures, results } = input;
	const names = new Map(clubs.map((c) => [c.clubId, c.name]));
	const nameOf = (id: number) => names.get(id) ?? `#${id}`;
	const fixtureById = new Map(fixtures.map((f) => [f.fixtureId, f]));

	const played = results.flatMap((r) => {
		const f = fixtureById.get(r.fixtureId);
		return f
			? [
					{
						fixtureId: f.fixtureId,
						round: f.round,
						homeClubId: f.homeClubId,
						awayClubId: f.awayClubId,
						homeGoals: r.homeGoals,
						awayGoals: r.awayGoals,
					},
				]
			: [];
	});

	const next = fixtures
		.filter(
			(f) =>
				f.round >= currentRound &&
				f.round <= totalRounds &&
				(f.homeClubId === clubId || f.awayClubId === clubId),
		)
		.sort(
			(a, b) =>
				a.round - b.round || a.kickoffAt.getTime() - b.kickoffAt.getTime(),
		)[0];

	const previous = currentRound - 1;
	return {
		aiFinished: aiFinishedOf(input, nameOf),
		clubId,
		clubName: nameOf(clubId),
		round: currentRound,
		totalRounds,
		nextMatch: next
			? {
					fixtureId: next.fixtureId,
					opponent: nameOf(
						next.homeClubId === clubId ? next.awayClubId : next.homeClubId,
					),
					home: next.homeClubId === clubId,
					kickoffAt: next.kickoffAt,
					round: next.round,
				}
			: null,
		table: leagueTable(played, clubs),
		previousRound:
			previous >= 1
				? {
						round: previous,
						matches: played
							.filter((p) => p.round === previous)
							.map((p) => ({
								home: nameOf(p.homeClubId),
								away: nameOf(p.awayClubId),
								homeGoals: p.homeGoals,
								awayGoals: p.awayGoals,
							})),
					}
				: null,
	};
}

function aiFinishedOf(
	input: RoundScreenInput,
	nameOf: (clubId: number) => string,
): RoundScreen["aiFinished"] {
	const live = input.liveMatch;
	// The previous position: round 1 of a later season follows the last round of the one before.
	const previous =
		input.currentRound > 1
			? { seasonNo: input.seasonNo, round: input.currentRound - 1 }
			: { seasonNo: input.seasonNo - 1, round: input.totalRounds };
	if (
		live?.status !== "finished" ||
		previous.seasonNo < 1 ||
		live.seasonNo !== previous.seasonNo ||
		live.round !== previous.round
	) {
		return null;
	}
	const fromMinute = aiTakeover(live.changes);
	if (fromMinute === null) return null;
	const f = input.fixtures.find((x) => x.fixtureId === live.fixtureId);
	// From the row's own season: `results` hold only the current season.
	const r = live.result;
	if (!f || !r) return null;
	return {
		home: nameOf(f.homeClubId),
		away: nameOf(f.awayClubId),
		score: { home: r.homeGoals, away: r.awayGoals },
		fromMinute,
	};
}
