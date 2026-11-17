// Load stage of the openfootball import: writes one normalized league season to the database.
// A league already loaded from API-Football (fixtures with api_id) is only matched: openfootball
// club keys are stored in club.source_key. Otherwise rows are created, keyed by source_key.

import { and, eq, isNotNull, sql } from "drizzle-orm";

import {
	type Db,
	idMap,
	type TableCounts,
	upsert,
} from "~/import/api-football/load";
import { club, competitionSeason, fixture } from "~/server/db/schema";
import { matchClubsByFixtures } from "./match-clubs";
import type { NormalizedOpenSeason } from "./normalize";

export type OpenLoadMode = "matched" | "created";

export function openLoadMode(input: {
	seasonExists: boolean;
	fixtures: number;
	withApiId: number;
}): OpenLoadMode {
	if (!input.seasonExists || input.fixtures === 0) return "created";
	if (input.withApiId === 0) return "created";
	if (input.withApiId === input.fixtures) return "matched";
	throw new Error(
		`Season has ${input.withApiId} of ${input.fixtures} fixtures with api_id: mixed sources, refusing to load.`,
	);
}

export type OpenLoadResult =
	| { mode: "matched"; clubs: number }
	| {
			mode: "created";
			clubs: TableCounts;
			fixtures: TableCounts;
			skipped: number;
	  };

export async function loadOpenSeason(
	db: Db,
	n: NormalizedOpenSeason,
): Promise<OpenLoadResult> {
	return db.transaction(async (tx) => {
		const { leagueApiId, season } = n.competition;
		const [cs] = await tx
			.select({ id: competitionSeason.id })
			.from(competitionSeason)
			.where(
				and(
					eq(competitionSeason.leagueApiId, leagueApiId),
					eq(competitionSeason.season, season),
				),
			);
		let fixtures = 0;
		let withApiId = 0;
		if (cs) {
			const [c] = await tx
				.select({
					fixtures: sql<number>`count(*)::int`,
					withApiId: sql<number>`count(${fixture.apiId})::int`,
				})
				.from(fixture)
				.where(eq(fixture.competitionSeasonId, cs.id));
			fixtures = c?.fixtures ?? 0;
			withApiId = c?.withApiId ?? 0;
		}
		const mode = openLoadMode({
			seasonExists: !!cs,
			fixtures,
			withApiId,
		});

		if (mode === "matched" && cs) {
			const existing = await tx
				.select({
					homeClubId: fixture.homeClubId,
					awayClubId: fixture.awayClubId,
					kickoffAt: fixture.kickoffAt,
				})
				.from(fixture)
				.where(
					and(eq(fixture.competitionSeasonId, cs.id), isNotNull(fixture.apiId)),
				);
			const map = matchClubsByFixtures(n.fixtures, existing);
			for (const [sourceKey, clubId] of map) {
				await tx.update(club).set({ sourceKey }).where(eq(club.id, clubId));
			}
			return { mode: "matched", clubs: map.size } as const;
		}

		const compRes = await upsert(
			tx,
			competitionSeason,
			[n.competition],
			["leagueApiId", "season"],
		);
		const competitionSeasonId = idMap(compRes.rows, "leagueApiId").get(
			leagueApiId,
		);
		if (competitionSeasonId === undefined)
			throw new Error(
				`competition_season ${leagueApiId}/${season} not written`,
			);

		const clubRes = await upsert(
			tx,
			club,
			n.clubs.map((c) => ({
				sourceKey: c.sourceKey,
				name: c.name,
				country: c.country,
			})),
			["sourceKey"],
			{ keep: ["apiId"] },
		);
		const clubIds = idMap<string>(clubRes.rows, "sourceKey");
		const need = (key: string) => {
			const id = clubIds.get(key);
			if (id === undefined) throw new Error(`Club ${key} was not written`);
			return id;
		};

		const fixtureRes = await upsert(
			tx,
			fixture,
			n.fixtures.map(({ homeKey, awayKey, ...rest }) => ({
				...rest,
				competitionSeasonId,
				homeClubId: need(homeKey),
				awayClubId: need(awayKey),
			})),
			["sourceKey"],
			{ keep: ["apiId"] },
		);
		return {
			mode: "created",
			clubs: clubRes.counts,
			fixtures: fixtureRes.counts,
			skipped: n.skipped,
		} as const;
	});
}
