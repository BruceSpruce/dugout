// Probe API-Football (v3) before committing to it as the PL snapshot source (PRD Open Question #1).
// Answers: does our plan see the chosen season, what does coverage say, how many requests a full
// import needs, and are per-player stats rich enough to derive attributes (FR-002).
//
// Run:   npm run probe:api-football -- [--season 2025] [--league 39] [--max-requests 8]
// Needs: API_FOOTBALL_KEY in .env. /status is free; the rest costs ~5 requests of the daily quota.
// Raw responses are saved to .data/api-football/probe/ (gitignored) for later inspection.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
	type ApiResult,
	createClient,
	errorsText,
} from "../src/import/api-football/client";

const OUT_DIR = join(".data", "api-football", "probe");

type Json = Record<string, unknown>;

function arg(name: string, fallback?: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i > -1 ? process.argv[i + 1] : fallback;
}

const key = process.env.API_FOOTBALL_KEY;
if (!key) {
	console.error("Missing API_FOOTBALL_KEY (add it to .env).");
	process.exit(1);
}

const league = Number(arg("league", "39"));
const maxRequests = Number(arg("max-requests", "8"));
const client = createClient({ apiKey: key, maxRequests });

// Probe tolerates API-level `errors` (prints them and carries on), and keeps every raw response.
async function get(
	path: string,
	params: Record<string, string | number> = {},
): Promise<ApiResult> {
	const body = await client.get(path, params, { tolerateApiErrors: true });
	const file = `${path.replaceAll("/", "_").replace(/^_/, "")}${
		Object.keys(params).length
			? `__${new URLSearchParams(params as Record<string, string>)}`
			: ""
	}.json`.replace(/[&=]/g, "-");
	await writeFile(join(OUT_DIR, file), JSON.stringify(body, null, 2));
	return body;
}

function errorsOf(r: ApiResult): string {
	return errorsText(r.errors);
}

function pct(n: number, d: number): string {
	return d ? `${Math.round((100 * n) / d)}%` : "n/a";
}

function dig(o: unknown, path: string): unknown {
	let cur: unknown = o;
	for (const p of path.split(".")) {
		if (cur === null || typeof cur !== "object") return undefined;
		cur = (cur as Json)[p];
	}
	return cur;
}

async function main(): Promise<void> {
	await mkdir(OUT_DIR, { recursive: true });

	// ad 1. Account and quota (free call).
	const status = await get("/status");
	const sub = dig(status.response, "subscription") as Json | undefined;
	const req = dig(status.response, "requests") as Json | undefined;
	console.log(
		`1. plan=${sub?.plan} active=${sub?.active} end=${sub?.end} requests today=${req?.current}/${req?.limit_day}`,
	);

	// ad 2. League seasons + coverage flags.
	const lg = await get("/leagues", { id: league });
	const lgErr = errorsOf(lg);
	if (lgErr) console.log(`2. errors: ${lgErr}`);
	const entry = (lg.response as Json[])[0];
	const seasons = (entry?.seasons as Json[] | undefined) ?? [];
	const current = seasons.find((s) => s.current === true);
	const season = Number(arg("season", String(current?.year ?? "")));
	const chosen = seasons.find((s) => s.year === season);
	console.log(
		`2. league=${dig(entry, "league.name")} seasons=${seasons.map((s) => s.year).join(",")} current=${current?.year} chosen=${season}`,
	);
	if (chosen) {
		const c = chosen.coverage as Json;
		const fx = c.fixtures as Json;
		console.log(
			`   coverage: players=${c.players} injuries=${c.injuries} standings=${c.standings} lineups=${fx.lineups} events=${fx.events} statistics_players=${fx.statistics_players} (${chosen.start}..${chosen.end})`,
		);
	}

	// ad 3. Teams (does the plan see this season at all?).
	const teams = await get("/teams", { league, season });
	const teamErr = errorsOf(teams);
	const teamList = (teams.response as Json[]) ?? [];
	console.log(
		`3. teams=${teamList.length}${teamErr ? ` errors: ${teamErr}` : ""}`,
	);
	if (teamErr || teamList.length === 0) {
		console.log(
			"   Plan cannot see this season — stop here; try --season with an older year or a paid plan.",
		);
		return summary(season, undefined);
	}

	// ad 4. Fixtures: count and status breakdown.
	const fixtures = await get("/fixtures", { league, season });
	const fxList = (fixtures.response as Json[]) ?? [];
	const byStatus = new Map<string, number>();
	for (const f of fxList) {
		const s = String(dig(f, "fixture.status.short"));
		byStatus.set(s, (byStatus.get(s) ?? 0) + 1);
	}
	console.log(
		`4. fixtures=${fxList.length} status: ${[...byStatus].map(([k, v]) => `${k}=${v}`).join(" ")}${errorsOf(fixtures) ? ` errors: ${errorsOf(fixtures)}` : ""}`,
	);

	// ad 5. One squad (current roster, no stats).
	const firstTeam = teamList[0];
	const teamId = dig(firstTeam, "team.id") as number;
	const squad = await get("/players/squads", { team: teamId });
	const players =
		(dig((squad.response as Json[])[0], "players") as Json[] | undefined) ?? [];
	const positions = new Map<string, number>();
	for (const p of players)
		positions.set(
			String(p.position),
			(positions.get(String(p.position)) ?? 0) + 1,
		);
	console.log(
		`5. squad ${dig(firstTeam, "team.name")}: players=${players.length} ${[...positions].map(([k, v]) => `${k}=${v}`).join(" ")}`,
	);

	// ad 6. Player season stats, page 1: paging + field completeness.
	const ps = await get("/players", { league, season, page: 1 });
	const rows = (ps.response as Json[]) ?? [];
	const fields = [
		"games.minutes",
		"games.rating",
		"games.position",
		"goals.total",
		"passes.total",
		"passes.accuracy",
		"tackles.total",
		"duels.won",
		"dribbles.success",
		"shots.on",
		"cards.yellow",
	];
	const filled = fields.map((f) => {
		const n = rows.filter((r) => {
			const v = dig(((r.statistics as Json[]) ?? [])[0], f);
			return v !== null && v !== undefined;
		}).length;
		return `${f}=${pct(n, rows.length)}`;
	});
	console.log(
		`6. players page 1/${ps.paging?.total} rows=${rows.length}${errorsOf(ps) ? ` errors: ${errorsOf(ps)}` : ""}`,
	);
	console.log(`   non-null on page 1: ${filled.join(" ")}`);

	return summary(season, ps.paging?.total, teamList.length);
}

function summary(season: number, playerPages?: number, teamCount = 20): void {
	const est =
		playerPages === undefined ? "n/a" : 1 + 1 + teamCount + playerPages;
	console.log(
		`7. season=${season} requests spent=${client.spent} remaining(header)=${client.remaining ?? "n/a"} est. full import = teams 1 + fixtures 1 + squads ${teamCount} + player pages ${playerPages ?? "?"} = ${est}`,
	);
	console.log(`   raw JSON: ${OUT_DIR}/`);
}

main().catch((e: unknown) => {
	console.error(
		`probe failed: ${e instanceof Error ? e.message : String(e)} (requests spent=${client.spent})`,
	);
	process.exit(1);
});
