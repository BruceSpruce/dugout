// Normalization stage: pure functions turning raw API-Football responses into domain rows.
// No I/O. Rows reference other tables by API id; `load.ts` resolves them to database ids.

import type {
	club,
	competitionSeason,
	fixture,
	player,
	playerSeasonStats,
	squadMember,
} from "~/server/db/schema";

type Raw = { response?: unknown };

type Obj = Record<string, unknown>;

export type CompetitionSeasonRow = typeof competitionSeason.$inferInsert;
export type ClubRow = typeof club.$inferInsert;
export type PlayerRow = typeof player.$inferInsert;
export type StatsRow = Omit<
	typeof playerSeasonStats.$inferInsert,
	"playerId" | "clubId" | "competitionSeasonId"
> & { playerApiId: number; clubApiId: number };
export type SquadRow = Omit<
	typeof squadMember.$inferInsert,
	"playerId" | "clubId" | "competitionSeasonId"
> & { playerApiId: number; clubApiId: number };
export type FixtureRow = Omit<
	typeof fixture.$inferInsert,
	"competitionSeasonId" | "homeClubId" | "awayClubId"
> & { homeClubApiId: number; awayClubApiId: number };

function obj(value: unknown): Obj {
	return typeof value === "object" && value !== null ? (value as Obj) : {};
}

function rows(raw: Raw, what: string): Obj[] {
	if (!Array.isArray(raw.response))
		throw new Error(`${what}: response is not an array`);
	return raw.response.map(obj);
}

function str(value: unknown): string | null {
	return typeof value === "string" && value !== "" ? value : null;
}

function reqInt(value: unknown, what: string): number {
	if (typeof value !== "number" || !Number.isInteger(value))
		throw new Error(`Missing or invalid ${what}: ${JSON.stringify(value)}`);
	return value;
}

// Counters: null (or anything non-numeric) means "nothing happened".
function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function nullableInt(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) ? value : null;
}

// "6.964516" -> 6.964516, anything unparsable -> null.
export function parseRating(value: unknown): number | null {
	if (value === null || value === undefined || value === "") return null;
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

// "180 cm" / "75 kg" / "180" / 180 -> int; null/garbage -> null.
export function parseMeasure(value: unknown): number | null {
	if (typeof value === "number")
		return Number.isFinite(value) ? Math.round(value) : null;
	if (typeof value !== "string") return null;
	const m = /^\s*(\d+(?:\.\d+)?)\s*(?:cm|kg)?\s*$/i.exec(value);
	return m?.[1] ? Math.round(Number(m[1])) : null;
}

// "Regular Season - 12" -> 12; any other round format is an error (cups, play-offs: not supported).
export function parseRound(value: unknown): number {
	const m =
		typeof value === "string" ? /^Regular Season - (\d+)$/.exec(value) : null;
	if (!m?.[1])
		throw new Error(`Unsupported round format: ${JSON.stringify(value)}`);
	return Number(m[1]);
}

export function normalizeTeams(raw: Raw): ClubRow[] {
	return rows(raw, "teams").map((row) => {
		const team = obj(row.team);
		return {
			apiId: reqInt(team.id, "team.id"),
			name: str(team.name) ?? `team-${String(team.id)}`,
			code: str(team.code),
			country: str(team.country),
			logoUrl: str(team.logo),
		};
	});
}

function toDate(value: unknown, what: string): Date {
	const d = typeof value === "string" ? new Date(value) : null;
	if (!d || Number.isNaN(d.getTime()))
		throw new Error(`Invalid ${what}: ${JSON.stringify(value)}`);
	return d;
}

export function normalizeFixtures(raw: Raw): FixtureRow[] {
	return rows(raw, "fixtures").map((row) => {
		const f = obj(row.fixture);
		const teams = obj(row.teams);
		const goals = obj(row.goals);
		const half = obj(obj(row.score).halftime);
		const id = reqInt(f.id, "fixture.id");
		return {
			apiId: id,
			round: parseRound(obj(row.league).round),
			kickoffAt: toDate(f.date, `fixture ${id} date`),
			status: str(obj(f.status).short) ?? "NS",
			homeClubApiId: reqInt(obj(teams.home).id, `fixture ${id} home id`),
			awayClubApiId: reqInt(obj(teams.away).id, `fixture ${id} away id`),
			homeGoals: nullableInt(goals.home),
			awayGoals: nullableInt(goals.away),
			homeGoalsHt: nullableInt(half.home),
			awayGoalsHt: nullableInt(half.away),
		};
	});
}

const day = (d: Date) => d.toISOString().slice(0, 10);

// Name, country and season come from the `league` object of the fixtures response; dates from the
// first and last kickoff. No /leagues request needed.
export function normalizeCompetitionSeason(raw: Raw): CompetitionSeasonRow {
	const list = rows(raw, "fixtures");
	const first = list[0];
	if (!first) throw new Error("fixtures: empty response, no league data");
	const league = obj(first.league);
	const times = list.map((r) =>
		toDate(obj(r.fixture).date, "fixture date").getTime(),
	);
	return {
		leagueApiId: reqInt(league.id, "league.id"),
		season: reqInt(league.season, "league.season"),
		name: str(league.name) ?? `league-${String(league.id)}`,
		country: str(league.country),
		startsOn: day(new Date(Math.min(...times))),
		endsOn: day(new Date(Math.max(...times))),
	};
}

type StatEntry = { stats: StatsRow; clubApiId: number };

function statsRow(playerApiId: number, clubApiId: number, s: Obj): StatsRow {
	const games = obj(s.games);
	const subs = obj(s.substitutes);
	const shots = obj(s.shots);
	const goals = obj(s.goals);
	const passes = obj(s.passes);
	const tackles = obj(s.tackles);
	const duels = obj(s.duels);
	const dribbles = obj(s.dribbles);
	const fouls = obj(s.fouls);
	const cards = obj(s.cards);
	const pen = obj(s.penalty);
	return {
		playerApiId,
		clubApiId,
		position: str(games.position),
		// "appearences" is the API's own spelling.
		appearances: count(games.appearences),
		lineups: count(games.lineups),
		minutes: count(games.minutes),
		subsIn: count(subs.in),
		subsOut: count(subs.out),
		bench: count(subs.bench),
		shotsTotal: count(shots.total),
		shotsOn: count(shots.on),
		goals: count(goals.total),
		goalsConceded: count(goals.conceded),
		assists: count(goals.assists),
		saves: count(goals.saves),
		passesTotal: count(passes.total),
		passesKey: count(passes.key),
		tackles: count(tackles.total),
		blocks: count(tackles.blocks),
		interceptions: count(tackles.interceptions),
		duels: count(duels.total),
		duelsWon: count(duels.won),
		dribblesAttempts: count(dribbles.attempts),
		dribblesSuccess: count(dribbles.success),
		dribblesPast: count(dribbles.past),
		foulsDrawn: count(fouls.drawn),
		foulsCommitted: count(fouls.committed),
		yellowCards: count(cards.yellow),
		yellowRedCards: count(cards.yellowred),
		redCards: count(cards.red),
		penaltyWon: count(pen.won),
		penaltyCommitted: count(pen.commited), // API typo
		penaltyScored: count(pen.scored),
		penaltyMissed: count(pen.missed),
		penaltySaved: count(pen.saved),
		rating: parseRating(games.rating),
		passesAccuracyRaw: parseAccuracy(passes.accuracy),
	};
}

// Stored as received (integer), no interpretation of what the number means.
function parseAccuracy(value: unknown): number | null {
	if (value === null || value === undefined || value === "") return null;
	const n =
		typeof value === "number" ? value : Number(String(value).replace("%", ""));
	return Number.isFinite(n) ? Math.round(n) : null;
}

// Game club: most minutes; tie -> higher rating (null is lowest); still a tie -> the later entry.
function pickGameClub(entries: StatEntry[]): StatEntry {
	let best = entries[0];
	if (!best) throw new Error("pickGameClub: no entries");
	for (const e of entries.slice(1)) {
		const a = e.stats;
		const b = best.stats;
		const ra = a.rating ?? Number.NEGATIVE_INFINITY;
		const rb = b.rating ?? Number.NEGATIVE_INFINITY;
		const aMin = a.minutes ?? 0;
		const bMin = b.minutes ?? 0;
		if (aMin > bMin || (aMin === bMin && ra >= rb)) best = e;
	}
	return best;
}

export type NormalizedPlayers = {
	players: PlayerRow[];
	stats: StatsRow[];
	squad: SquadRow[];
};

// rawPages: every /players-shaped response (per-team pages of all clubs plus player-<id>.json).
// A transferred player appears in several responses: rows are merged by player.id, their
// statistics[] concatenated in input order, entries of other leagues dropped, and one row per
// (player, club) kept (a later duplicate replaces an earlier one).
export function normalizePlayers(
	rawPages: Raw[],
	leagueApiId: number,
): NormalizedPlayers {
	const byPlayer = new Map<
		number,
		{ player: PlayerRow; clubs: Map<number, StatEntry> }
	>();

	for (const page of rawPages) {
		for (const row of rows(page, "players")) {
			const p = obj(row.player);
			const id = reqInt(p.id, "player.id");
			let acc = byPlayer.get(id);
			if (!acc) {
				acc = {
					player: {
						apiId: id,
						firstName: str(p.firstname),
						lastName: str(p.lastname),
						name: str(p.name) ?? `player-${id}`,
						birthDate: str(obj(p.birth).date),
						nationality: str(p.nationality),
						heightCm: parseMeasure(p.height),
						weightKg: parseMeasure(p.weight),
					},
					clubs: new Map(),
				};
				byPlayer.set(id, acc);
			}
			const list = Array.isArray(row.statistics) ? row.statistics.map(obj) : [];
			for (const s of list) {
				if (obj(s.league).id !== leagueApiId) continue;
				const clubApiId = reqInt(obj(s.team).id, `player ${id} team.id`);
				acc.clubs.delete(clubApiId);
				acc.clubs.set(clubApiId, {
					clubApiId,
					stats: statsRow(id, clubApiId, s),
				});
			}
		}
	}

	const out: NormalizedPlayers = { players: [], stats: [], squad: [] };
	for (const { player: p, clubs } of byPlayer.values()) {
		const entries = [...clubs.values()];
		if (entries.length === 0) continue; // never played in this league/season
		out.players.push(p);
		for (const e of entries) out.stats.push(e.stats);
		const game = pickGameClub(entries);
		out.squad.push({
			playerApiId: game.stats.playerApiId,
			clubApiId: game.clubApiId,
			position: game.stats.position ?? null,
		});
	}
	return out;
}
