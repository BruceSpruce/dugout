// Completeness report for one imported (league, season). `queryAggregates` is the thin SQL layer;
// `buildReport` is pure (aggregates in, lines + warnings + exit code out).

import { sql } from "drizzle-orm";

import { MINUTES_COVERAGE } from "./fetch";
import type { Db } from "./load";

const MINUTES_PER_MATCH = 11 * 90;

export type ClubAggregate = {
	name: string;
	squad: number;
	withMinutes: number;
	minutes: number;
	// Fixtures with a score (played), home or away.
	playedFixtures: number;
};

export type Aggregates = {
	season: {
		name: string;
		startsOn: string | null;
		endsOn: string | null;
	} | null;
	clubs: ClubAggregate[];
	fixtures: {
		total: number;
		byStatus: Record<string, number>;
		// Fixtures per round.
		rounds: number[];
		finishedWithoutScore: number;
	};
	players: {
		total: number;
		withMinutes: number;
		byPosition: Record<string, number>;
	};
	multiClub: { count: number; examples: string[] };
	goals: { fixtures: number; players: number };
};

export type Report = { lines: string[]; warnings: string[]; exitCode: 0 | 3 };

function range(values: number[]): string {
	if (values.length === 0) return "n/a";
	return `${Math.min(...values)}/${Math.max(...values)}`;
}

function dist(d: Record<string, number>): string {
	const parts = Object.entries(d)
		.sort((a, b) => b[1] - a[1])
		.map(([k, v]) => `${k}=${v}`);
	return parts.length ? parts.join(" ") : "none";
}

export function minutesCoverage(c: ClubAggregate): number | null {
	const expected = c.playedFixtures * MINUTES_PER_MATCH;
	return expected > 0 ? c.minutes / expected : null;
}

export function buildReport(a: Aggregates): Report {
	if (!a.season) {
		return {
			lines: ["1. Season not loaded (no competition_season row)."],
			warnings: ["season not loaded"],
			exitCode: 3,
		};
	}
	const lines: string[] = [];
	const warnings: string[] = [];

	lines.push(
		`1. Season: ${a.season.name} ${a.season.startsOn ?? "?"} .. ${a.season.endsOn ?? "?"}`,
	);
	lines.push(`2. Clubs: ${a.clubs.length}`);

	const perRound: Record<number, number> = {};
	for (const r of a.fixtures.rounds) perRound[r] = (perRound[r] ?? 0) + 1;
	const roundCounts = Object.values(perRound);
	lines.push(
		`3. Fixtures: ${a.fixtures.total} (${dist(a.fixtures.byStatus)}); rounds=${roundCounts.length}, per round min/max=${range(roundCounts)}`,
	);

	lines.push(
		`4. Players: ${a.players.total}, minutes>0: ${a.players.withMinutes}; positions: ${dist(a.players.byPosition)}`,
	);

	lines.push(
		`5. Players with >=2 stat rows: ${a.multiClub.count}${a.multiClub.examples.length ? ` (e.g. ${a.multiClub.examples.slice(0, 5).join("; ")})` : ""}`,
	);

	const coverage: { name: string; ratio: number }[] = [];
	for (const c of a.clubs) {
		const ratio = minutesCoverage(c);
		if (ratio !== null) coverage.push({ name: c.name, ratio });
	}
	const ratios = coverage.map((c) => c.ratio);
	const low = coverage
		.filter((c) => c.ratio < MINUTES_COVERAGE)
		.sort((x, y) => x.ratio - y.ratio);
	lines.push(
		`6. Squads: size min/max=${range(a.clubs.map((c) => c.squad))}; players with minutes min/max=${range(a.clubs.map((c) => c.withMinutes))}`,
	);
	lines.push(
		ratios.length
			? `   minutes coverage min/max=${Math.min(...ratios).toFixed(2)}/${Math.max(...ratios).toFixed(2)}; below ${MINUTES_COVERAGE}: ${low.length ? low.map((c) => `${c.name} ${c.ratio.toFixed(2)}`).join(", ") : "none"}`
			: "   minutes coverage: n/a (no played fixtures)",
	);

	const diff = a.goals.fixtures - a.goals.players;
	lines.push(
		`7. Goals: fixtures=${a.goals.fixtures} players=${a.goals.players} diff=${diff} (own goals, missing data; info only)`,
	);

	const noSquad = a.clubs.filter((c) => c.squad === 0).map((c) => c.name);
	if (noSquad.length)
		warnings.push(`clubs without squad: ${noSquad.join(", ")}`);
	if (a.fixtures.finishedWithoutScore > 0)
		warnings.push(
			`FT fixtures without score: ${a.fixtures.finishedWithoutScore}`,
		);
	if (low.length)
		warnings.push(
			`${low.length} club(s) with minutes coverage < ${MINUTES_COVERAGE} (players missing, Free page limit)`,
		);

	lines.push(
		warnings.length ? `8. Warnings: ${warnings.length}` : "8. Warnings: none",
	);
	for (const w of warnings) lines.push(`   - ${w}`);

	return { lines, warnings, exitCode: warnings.length ? 3 : 0 };
}

export async function queryAggregates(
	db: Db,
	league: number,
	season: number,
): Promise<Aggregates> {
	const seasonRows = await db.execute<{
		id: number;
		name: string;
		starts_on: string | null;
		ends_on: string | null;
	}>(
		sql`select id, name, starts_on::text as starts_on, ends_on::text as ends_on
			from dugout_competition_season where league_api_id = ${league} and season = ${season}`,
	);
	const s = seasonRows[0];
	const empty: Aggregates = {
		season: null,
		clubs: [],
		fixtures: { total: 0, byStatus: {}, rounds: [], finishedWithoutScore: 0 },
		players: { total: 0, withMinutes: 0, byPosition: {} },
		multiClub: { count: 0, examples: [] },
		goals: { fixtures: 0, players: 0 },
	};
	if (!s) return empty;
	const id = s.id;

	const clubRows = await db.execute<{
		name: string;
		squad: number;
		with_minutes: number;
		minutes: number;
		played: number;
	}>(sql`
		with season_clubs as (
			select home_club_id as club_id from dugout_fixture where competition_season_id = ${id}
			union
			select away_club_id from dugout_fixture where competition_season_id = ${id}
		)
		select c.name,
			(select count(*)::int from dugout_squad_member m
				where m.club_id = c.id and m.competition_season_id = ${id}) as squad,
			(select count(*)::int from dugout_player_season_stats p
				where p.club_id = c.id and p.competition_season_id = ${id} and p.minutes > 0) as with_minutes,
			(select coalesce(sum(p.minutes), 0)::int from dugout_player_season_stats p
				where p.club_id = c.id and p.competition_season_id = ${id}) as minutes,
			(select count(*)::int from dugout_fixture f
				where f.competition_season_id = ${id} and f.home_goals is not null
				and (f.home_club_id = c.id or f.away_club_id = c.id)) as played
		from season_clubs sc join dugout_club c on c.id = sc.club_id
		order by c.name`);

	const fixtureRows = await db.execute<{
		round: number;
		status: string;
		scored: boolean;
	}>(
		sql`select round, status, (home_goals is not null and away_goals is not null) as scored
			from dugout_fixture where competition_season_id = ${id}`,
	);
	const byStatus: Record<string, number> = {};
	let finishedWithoutScore = 0;
	for (const f of fixtureRows) {
		byStatus[f.status] = (byStatus[f.status] ?? 0) + 1;
		if (f.status === "FT" && !f.scored) finishedWithoutScore++;
	}

	const playerTotals = await db.execute<{
		total: number;
		with_minutes: number;
	}>(
		sql`select
			(select count(*)::int from dugout_squad_member where competition_season_id = ${id}) as total,
			(select count(distinct player_id)::int from dugout_player_season_stats
				where competition_season_id = ${id} and minutes > 0) as with_minutes`,
	);
	const positionRows = await db.execute<{ position: string; n: number }>(
		sql`select coalesce(position, 'n/a') as position, count(*)::int as n
			from dugout_squad_member where competition_season_id = ${id} group by 1`,
	);
	const byPosition: Record<string, number> = {};
	for (const r of positionRows) byPosition[r.position] = r.n;

	const multi = await db.execute<{ name: string; clubs: string }>(
		sql`select pl.name, string_agg(c.name, '+' order by c.name) as clubs
			from dugout_player_season_stats st
			join dugout_player pl on pl.id = st.player_id
			join dugout_club c on c.id = st.club_id
			where st.competition_season_id = ${id}
			group by pl.id, pl.name having count(*) >= 2 order by pl.name`,
	);

	const goals = await db.execute<{ fixtures: number; players: number }>(
		sql`select
			(select coalesce(sum(coalesce(home_goals, 0) + coalesce(away_goals, 0)), 0)::int
				from dugout_fixture where competition_season_id = ${id}) as fixtures,
			(select coalesce(sum(goals), 0)::int from dugout_player_season_stats
				where competition_season_id = ${id}) as players`,
	);

	return {
		season: { name: s.name, startsOn: s.starts_on, endsOn: s.ends_on },
		clubs: clubRows.map((r) => ({
			name: r.name,
			squad: r.squad,
			withMinutes: r.with_minutes,
			minutes: r.minutes,
			playedFixtures: r.played,
		})),
		fixtures: {
			total: fixtureRows.length,
			byStatus,
			rounds: fixtureRows.map((f) => f.round),
			finishedWithoutScore,
		},
		players: {
			total: playerTotals[0]?.total ?? 0,
			withMinutes: playerTotals[0]?.with_minutes ?? 0,
			byPosition,
		},
		multiClub: {
			count: multi.length,
			examples: multi.slice(0, 5).map((m) => `${m.name} (${m.clubs})`),
		},
		goals: {
			fixtures: goals[0]?.fixtures ?? 0,
			players: goals[0]?.players ?? 0,
		},
	};
}
