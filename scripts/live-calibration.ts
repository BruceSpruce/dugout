// Live-match calibration: live matches with the AI coach on both sides on the real squads of one
// imported (league, season), against the PRD ranges. Read-only.
//
// Run:   npm run live:calibration -- --league 39 --season 2024 [--matches 3800] [--seed 1]
// Needs: DATABASE_URL in .env.
// Exit:  0 pass, 3 a gate failed, 1 error (usage, season not loaded).

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { buildLiveCalibrationReport } from "../src/engine/live-calibration";
import * as schema from "../src/server/db/schema";
import { loadSeasonInput } from "../src/server/engine-input/season-input";

const USAGE =
	"Usage: npm run live:calibration -- --league 39 --season 2024 [--matches 3800] [--seed 1]";

function arg(name: string, fallback?: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i > -1 ? process.argv[i + 1] : fallback;
}

async function main(): Promise<number> {
	const url = process.env.DATABASE_URL;
	if (!url) {
		console.error("Missing DATABASE_URL (add it to .env).");
		return 1;
	}
	const league = Number(arg("league", "39"));
	const season = Number(arg("season"));
	const matches = Number(arg("matches", "3800"));
	const seed = Number(arg("seed", "1"));
	if (
		!Number.isInteger(league) ||
		!Number.isInteger(season) ||
		!Number.isInteger(matches) ||
		matches < 1 ||
		!Number.isInteger(seed)
	) {
		console.error(USAGE);
		return 1;
	}
	const conn = postgres(url);
	try {
		const input = await loadSeasonInput(
			drizzle(conn, { schema }),
			league,
			season,
		);
		if (!input) {
			console.error("Season not loaded — run npm run import:season first");
			return 1;
		}
		const report = buildLiveCalibrationReport(
			{ season: `${league}/${season}`, ...input },
			{ matches, seed },
		);
		for (const line of report.lines) console.log(line);
		return report.exitCode;
	} finally {
		await conn.end();
	}
}

main().then(
	(code) => process.exit(code),
	(e: unknown) => {
		console.error(
			`live:calibration error: ${e instanceof Error ? e.message : String(e)}`,
		);
		process.exit(1);
	},
);
