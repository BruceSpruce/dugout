// Fetch stage: downloads the raw API-Football responses for one (league, season) into
// <dataDir>/<league>/<season>/. Resumable (existing files are skipped), budget-aware and never
// persists a response that carries `errors` (the client throws before we get to write).

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { type ApiResult, BudgetExhaustedError, type Client } from "./client";

export type FetchSeasonOptions = {
	league: number;
	season: number;
	dataDir: string;
	client: Client;
	// Highest /players page requested per team (Free plan limit is 3).
	maxPage?: number;
};

export type FetchSeasonResult = {
	requested: number;
	skipped: number;
	missingAfter: string[];
	// Teams whose paging.total exceeded maxPage (per-fixture fallback applies).
	fallbackTeams: number;
};

export function teamPageFile(teamId: number, page: number): string {
	return `players/team-${teamId}-page-${String(page).padStart(3, "0")}.json`;
}

export function teamFixtureFile(teamId: number, fixtureId: number): string {
	return `players/team-${teamId}-fixture-${fixtureId}.json`;
}

export function playerFile(playerId: number): string {
	return `players/player-${playerId}.json`;
}

type FixtureRef = { id: number; home?: unknown; away?: unknown };

function fixtureRefs(fixtures: ApiResult): FixtureRef[] {
	const out: FixtureRef[] = [];
	if (!Array.isArray(fixtures.response)) return out;
	for (const row of fixtures.response as Array<{
		fixture?: { id?: unknown };
		teams?: { home?: { id?: unknown }; away?: { id?: unknown } };
	}>) {
		const id = row?.fixture?.id;
		if (typeof id === "number")
			out.push({ id, home: row.teams?.home?.id, away: row.teams?.away?.id });
	}
	return out;
}

// Player ids from /players pages (response[].player.id).
function pagePlayerIds(body: ApiResult, into: Set<number>): void {
	if (!Array.isArray(body.response)) return;
	for (const row of body.response as Array<{ player?: { id?: unknown } }>) {
		const id = row?.player?.id;
		if (typeof id === "number") into.add(id);
	}
}

// Player ids from /fixtures/players (response[].players[].player.id).
function fixturePlayerIds(body: ApiResult, into: Set<number>): void {
	if (!Array.isArray(body.response)) return;
	for (const entry of body.response as Array<{
		players?: Array<{ player?: { id?: unknown } }>;
	}>) {
		for (const p of entry?.players ?? []) {
			const id = p?.player?.id;
			if (typeof id === "number") into.add(id);
		}
	}
}

// Pages 1..maxPage count as complete for a team when their league minutes reach this share of
// the expected total (team's fixtures × 11 × 90); then the per-fixture fallback is skipped.
export const MINUTES_COVERAGE = 0.95;

// Sum of league minutes for one team on /players pages (statistics[] filtered by team and league).
function pageMinutes(
	pages: ApiResult[],
	teamId: number,
	league: number,
): number {
	let sum = 0;
	for (const body of pages) {
		if (!Array.isArray(body.response)) continue;
		for (const row of body.response as Array<{
			statistics?: Array<{
				team?: { id?: unknown };
				league?: { id?: unknown };
				games?: { minutes?: unknown };
			}>;
		}>) {
			for (const s of row?.statistics ?? []) {
				const minutes = s?.games?.minutes;
				if (
					s?.team?.id === teamId &&
					s?.league?.id === league &&
					typeof minutes === "number"
				) {
					sum += minutes;
				}
			}
		}
	}
	return sum;
}

// Free plan rejects league-wide /players pages above 3, so players are fetched per team.
function teamIds(teams: ApiResult): number[] {
	const ids: number[] = [];
	if (!Array.isArray(teams.response)) return ids;
	for (const row of teams.response as Array<{ team?: { id?: unknown } }>) {
		const id = row?.team?.id;
		if (typeof id === "number") ids.push(id);
	}
	return ids;
}

async function readJson(path: string): Promise<ApiResult | null> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as ApiResult;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw e;
	}
}

// Atomic: write to a temp file, then rename, so an interrupted run never leaves truncated JSON.
async function writeAtomic(path: string, body: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.tmp`;
	await writeFile(tmp, JSON.stringify(body));
	await rename(tmp, path);
}

export async function fetchSeason(
	options: FetchSeasonOptions,
): Promise<FetchSeasonResult> {
	const { league, season, dataDir, client } = options;
	const maxPage = options.maxPage ?? 3;
	const root = join(dataDir, String(league), String(season));
	let requested = 0;
	let skipped = 0;
	let fallbackTeams = 0;
	const missingAfter: string[] = [];

	// Returns the stored/fetched body, or null when the budget ran out (file listed as missing).
	async function ensure(
		file: string,
		path: string,
		params: Record<string, string | number>,
	): Promise<ApiResult | null> {
		const target = join(root, file);
		const existing = await readJson(target);
		if (existing) {
			skipped++;
			return existing;
		}
		try {
			const body = await client.get(path, params);
			requested++;
			await writeAtomic(target, body);
			return body;
		} catch (e) {
			if (e instanceof BudgetExhaustedError) {
				missingAfter.push(file);
				return null;
			}
			throw e;
		}
	}

	const common = { league, season };
	const teams = await ensure("teams.json", "/teams", common);
	const fixtures = await ensure("fixtures.json", "/fixtures", common);

	// Without teams.json the team list is unknown: nothing more to list or fetch.
	if (teams) {
		for (const teamId of teamIds(teams)) {
			const params = { team: teamId, ...common };
			const first = await ensure(teamPageFile(teamId, 1), "/players", {
				...params,
				page: 1,
			});
			// The page count is only known once page 1 exists (paging.total).
			if (!first) continue;
			const total = first.paging?.total ?? 1;
			const pages: ApiResult[] = [first];
			for (let page = 2; page <= Math.min(total, maxPage); page++) {
				const body = await ensure(teamPageFile(teamId, page), "/players", {
					...params,
					page,
				});
				if (body) pages.push(body);
			}
			if (total > maxPage) {
				// Missing ids are computed against pages 1..maxPage, so all of them must be present.
				const pagesComplete = pages.length === maxPage;
				if (!pagesComplete || !fixtures) continue;
				// Minutes gap rule: skip the costly fallback when pages 1..maxPage already cover the season.
				const teamFixtures = fixtureRefs(fixtures).filter(
					(f) => f.home === teamId || f.away === teamId,
				).length;
				const expected = teamFixtures * 11 * 90;
				if (pageMinutes(pages, teamId, league) >= MINUTES_COVERAGE * expected)
					continue;
				fallbackTeams++;
				await fetchOverflow(teamId, pages, fixtures);
			}
		}
	}

	// Players beyond maxPage: per-match lineups first, then /players?id for ids missing on pages.
	async function fetchOverflow(
		teamId: number,
		pages: ApiResult[],
		fixtures: ApiResult | null,
	): Promise<void> {
		if (!fixtures) return;
		const refs = fixtureRefs(fixtures).filter(
			(f) => f.home === teamId || f.away === teamId,
		);
		const fixtureBodies: ApiResult[] = [];
		for (const ref of refs) {
			const body = await ensure(
				teamFixtureFile(teamId, ref.id),
				"/fixtures/players",
				{ fixture: ref.id, team: teamId },
			);
			if (body) fixtureBodies.push(body);
		}
		if (fixtureBodies.length < refs.length) return;

		const known = new Set<number>();
		for (const page of pages) pagePlayerIds(page, known);
		const seen = new Set<number>();
		for (const body of fixtureBodies) fixturePlayerIds(body, seen);
		const missing = [...seen]
			.filter((id) => !known.has(id))
			.sort((x, y) => x - y);
		for (const playerId of missing) {
			await ensure(playerFile(playerId), "/players", {
				id: playerId,
				...common,
			});
		}
	}
	return { requested, skipped, missingAfter, fallbackTeams };
}
