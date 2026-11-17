// Load stage: reads the raw files of one (league, season) from <dataDir>/<league>/<season>/,
// normalizes them and upserts into the database in one transaction. Natural keys (API ids) make
// a repeated load idempotent. Incomplete input is refused before anything is written.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { and, count, eq, getTableColumns, isNull, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type * as schema from "~/server/db/schema";
import {
	club,
	competitionSeason,
	fixture,
	player,
	playerSeasonStats,
	squadMember,
} from "~/server/db/schema";
import { playerFile, teamPageFile } from "./fetch";
import {
	normalizeCompetitionSeason,
	normalizeFixtures,
	normalizePlayers,
	normalizeTeams,
} from "./normalize";

type Raw = { response?: unknown; paging?: { total?: number } };

export type Db = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type LoadSeasonOptions = {
	db: Db;
	league: number;
	season: number;
	dataDir: string;
	// Highest /players page expected per team (same meaning as in fetch).
	maxPage?: number;
};

export type TableCounts = { inserted: number; updated: number };
export type LoadSeasonResult = Record<
	| "competitionSeason"
	| "club"
	| "player"
	| "playerSeasonStats"
	| "squadMember"
	| "fixture",
	TableCounts
>;

export class IncompleteDataError extends Error {
	constructor(readonly missing: string[]) {
		super(
			`Incomplete input, ${missing.length} file(s) missing (nothing was written): ${missing.slice(0, 20).join(", ")}${missing.length > 20 ? ", ..." : ""}. Run import:fetch to complete them.`,
		);
		this.name = "IncompleteDataError";
	}
}

async function readJson(path: string): Promise<Raw | null> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as Raw;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw e;
	}
}

export type SeasonFiles = {
	teams: Raw;
	fixtures: Raw;
	// Team pages first (team order, page order), then players/player-<id>.json by id.
	playerPages: Raw[];
};

// Complete = teams.json, fixtures.json, and for every team pages 1..min(paging.total, maxPage).
// Throws IncompleteDataError with the whole list of missing files.
export async function readSeasonFiles(
	root: string,
	maxPage = 3,
): Promise<SeasonFiles> {
	const missing: string[] = [];
	const teams = await readJson(join(root, "teams.json"));
	const fixtures = await readJson(join(root, "fixtures.json"));
	if (!teams) missing.push("teams.json");
	if (!fixtures) missing.push("fixtures.json");

	const playerPages: Raw[] = [];
	if (teams) {
		for (const club of normalizeTeams(teams)) {
			const firstName = teamPageFile(club.apiId, 1);
			const first = await readJson(join(root, firstName));
			if (!first) {
				missing.push(firstName);
				continue;
			}
			playerPages.push(first);
			const total = first.paging?.total ?? 1;
			for (let page = 2; page <= Math.min(total, maxPage); page++) {
				const name = teamPageFile(club.apiId, page);
				const body = await readJson(join(root, name));
				if (body) playerPages.push(body);
				else missing.push(name);
			}
		}
	}
	if (missing.length > 0) throw new IncompleteDataError(missing);

	// Players that were beyond the page limit, fetched one by one.
	let names: string[] = [];
	try {
		names = await readdir(join(root, "players"));
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
	}
	const ids = names
		.map((n) => /^player-(\d+)\.json$/.exec(n)?.[1])
		.filter((x): x is string => x !== undefined)
		.map(Number)
		.sort((a, b) => a - b);
	for (const id of ids) {
		const body = await readJson(join(root, playerFile(id)));
		if (body) playerPages.push(body);
	}
	// teams/fixtures were checked non-null above.
	return {
		teams: teams as Raw,
		fixtures: fixtures as Raw,
		playerPages,
	};
}

const CHUNK = 500;

// Upsert in chunks; returns id + natural-key columns of every touched row and the counts.
// `xmax = 0` is true only for rows freshly inserted by this statement.
// `keep` lists columns left out of DO UPDATE SET (owned by another data source).
export async function upsert<T extends PgTable>(
	tx: Tx,
	table: T,
	values: T["$inferInsert"][],
	target: Array<keyof T["_"]["columns"] & string>,
	options: { keep?: string[] } = {},
): Promise<{ rows: Array<Record<string, unknown>>; counts: TableCounts }> {
	const cols = getTableColumns(table) as Record<
		string,
		{ name: string; primary: boolean }
	>;
	const targetCols = target.map((k) => {
		const c = cols[k];
		if (!c) throw new Error(`Unknown column ${k}`);
		return c;
	});
	const set: Record<string, ReturnType<typeof sql.raw>> = {};
	for (const [key, c] of Object.entries(cols)) {
		if (c.primary || target.includes(key as never)) continue;
		if (options.keep?.includes(key)) continue;
		set[key] = sql.raw(`excluded."${c.name}"`);
	}
	const counts: TableCounts = { inserted: 0, updated: 0 };
	const rows: Array<Record<string, unknown>> = [];
	for (let i = 0; i < values.length; i += CHUNK) {
		const chunk = values.slice(i, i + CHUNK);
		const res = await tx
			.insert(table)
			.values(chunk)
			// biome-ignore lint/suspicious/noExplicitAny: generic helper over arbitrary tables
			.onConflictDoUpdate({ target: targetCols as any, set } as any)
			.returning({
				id: (cols as Record<string, never>).id,
				inserted: sql<boolean>`(xmax = 0)`,
				// biome-ignore lint/suspicious/noExplicitAny: key columns depend on the table
				...(Object.fromEntries(target.map((k) => [k, cols[k]])) as any),
			});
		for (const r of res as Array<Record<string, unknown>>) {
			if (r.inserted) counts.inserted++;
			else counts.updated++;
			rows.push(r);
		}
	}
	return { rows, counts };
}

export function idMap<K extends number | string = number>(
	rows: Array<Record<string, unknown>>,
	key: string,
) {
	return new Map(rows.map((r) => [r[key] as K, r.id as number]));
}

function need<K extends number | string>(
	map: Map<K, number>,
	apiId: K,
	what: string,
): number {
	const id = map.get(apiId);
	if (id === undefined)
		throw new Error(`${what} with API id ${apiId} is not in the loaded data`);
	return id;
}

// A league loaded from openfootball has fixtures without api_id; an API upsert on
// ON CONFLICT (api_id) would duplicate them, so it is refused.
export function apiLoadBlocked(counts: {
	fixtures: number;
	withoutApiId: number;
}): boolean {
	return counts.fixtures > 0 && counts.withoutApiId > 0;
}

export function apiLoadBlockedMessage(
	league: number,
	season: number,
	withoutApiId: number,
): string {
	return `League ${league} season ${season} was loaded from openfootball (${withoutApiId} fixtures without api_id); loading it from API-Football would duplicate clubs and fixtures. Loading real squads into an openfootball league is not supported yet.`;
}

type Reader = Pick<Db, "select">;

async function sourceCounts(db: Reader, league: number, season: number) {
	const [existing] = await db
		.select({
			fixtures: count(),
			withoutApiId: count(sql`case when ${isNull(fixture.apiId)} then 1 end`),
		})
		.from(fixture)
		.innerJoin(
			competitionSeason,
			eq(competitionSeason.id, fixture.competitionSeasonId),
		)
		.where(
			and(
				eq(competitionSeason.leagueApiId, league),
				eq(competitionSeason.season, season),
			),
		);
	return existing ?? { fixtures: 0, withoutApiId: 0 };
}

/** Message when loading (league, season) from the API would be refused, else null. */
export async function isApiLoadBlocked(
	db: Db,
	league: number,
	season: number,
): Promise<string | null> {
	const c = await sourceCounts(db, league, season);
	return apiLoadBlocked(c)
		? apiLoadBlockedMessage(league, season, c.withoutApiId)
		: null;
}

/** Serializes the loaders (API and openfootball) per league and season until commit. */
export async function lockSeason(
	tx: Tx,
	league: number,
	season: number,
): Promise<void> {
	await tx.execute(
		sql`select pg_advisory_xact_lock(${league}::int, ${season}::int)`,
	);
}

export async function loadSeason(
	options: LoadSeasonOptions,
): Promise<LoadSeasonResult> {
	const { db, league, season, dataDir } = options;
	const root = join(dataDir, String(league), String(season));
	const files = await readSeasonFiles(root, options.maxPage ?? 3);

	const comp = normalizeCompetitionSeason(files.fixtures);
	if (comp.leagueApiId !== league || comp.season !== season)
		throw new Error(
			`fixtures.json is for league ${comp.leagueApiId} season ${comp.season}, expected ${league}/${season}`,
		);
	const clubs = normalizeTeams(files.teams);
	const fixtures = normalizeFixtures(files.fixtures);
	const people = normalizePlayers(files.playerPages, league);

	return db.transaction(async (tx) => {
		await lockSeason(tx, league, season);
		const existing = await sourceCounts(tx, league, season);
		if (apiLoadBlocked(existing))
			throw new Error(
				apiLoadBlockedMessage(league, season, existing.withoutApiId),
			);

		const compRes = await upsert(
			tx,
			competitionSeason,
			[comp],
			["leagueApiId", "season"],
		);
		const competitionSeasonId = need(
			idMap(compRes.rows, "leagueApiId"),
			league,
			"Competition",
		);

		const clubRes = await upsert(tx, club, clubs, ["apiId"], {
			keep: ["sourceKey"],
		});
		const clubIds = idMap(clubRes.rows, "apiId");

		const playerRes = await upsert(tx, player, people.players, ["apiId"]);
		const playerIds = idMap(playerRes.rows, "apiId");

		const statsRes = await upsert(
			tx,
			playerSeasonStats,
			people.stats.map(({ playerApiId, clubApiId, ...rest }) => ({
				...rest,
				playerId: need(playerIds, playerApiId, "Player"),
				clubId: need(clubIds, clubApiId, "Club"),
				competitionSeasonId,
			})),
			["playerId", "clubId", "competitionSeasonId"],
		);

		const squadRes = await upsert(
			tx,
			squadMember,
			people.squad.map(({ playerApiId, clubApiId, ...rest }) => ({
				...rest,
				playerId: need(playerIds, playerApiId, "Player"),
				clubId: need(clubIds, clubApiId, "Club"),
				competitionSeasonId,
			})),
			["competitionSeasonId", "playerId"],
		);

		const fixtureRes = await upsert(
			tx,
			fixture,
			fixtures.map(({ homeClubApiId, awayClubApiId, ...rest }) => ({
				...rest,
				competitionSeasonId,
				homeClubId: need(clubIds, homeClubApiId, "Club"),
				awayClubId: need(clubIds, awayClubApiId, "Club"),
			})),
			["apiId"],
			{ keep: ["sourceKey"] },
		);

		return {
			competitionSeason: compRes.counts,
			club: clubRes.counts,
			player: playerRes.counts,
			playerSeasonStats: statsRes.counts,
			squadMember: squadRes.counts,
			fixture: fixtureRes.counts,
		};
	});
}
