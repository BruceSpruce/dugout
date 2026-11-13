// Calibration report: simulated seasons vs. the real league and PRD ranges for one imported (league, season). Read-only.
//
// Run:   npm run calibration:report -- --league 39 --season 2024 [--seasons 100] [--seed 1] [--club <name|apiId>]
// Needs: DATABASE_URL in .env.
// Exit:  0 pass, 3 a gate failed (league stats or lineup test), 1 error (usage, unknown club, season not loaded).

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { buildCalibrationReport } from "../src/engine/calibration-report";
import * as schema from "../src/server/db/schema";
import { loadSeasonInput } from "../src/server/engine-input/season-input";

const USAGE =
	"Usage: npm run calibration:report -- --league 39 --season 2024 [--seasons 100] [--seed 1] [--club <name|apiId>]";

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
	const seasons = Number(arg("seasons", "100"));
	const seed = Number(arg("seed", "1"));
	const club = arg("club");
	if (
		!Number.isInteger(league) ||
		!Number.isInteger(season) ||
		!Number.isInteger(seasons) ||
		seasons < 1 ||
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
		const report = buildCalibrationReport(
			{ season: `${league}/${season}`, ...input },
			{ seasons, seed, club },
		);
		const out = report.exitCode === 1 ? console.error : console.log;
		for (const line of report.lines) out(line);
		return report.exitCode;
	} finally {
		await conn.end();
	}
}

main().then(
	(code) => process.exit(code),
	(e: unknown) => {
		console.error(
			`calibration:report error: ${e instanceof Error ? e.message : String(e)}`,
		);
		process.exit(1);
	},
);
