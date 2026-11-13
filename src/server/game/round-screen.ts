// Round screen model: pure function, no DB. Uses only the game's own results.

import { leagueTable, type TableRow } from "~/engine/club-strength";

export type RoundScreenInput = {
	clubId: number;
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
