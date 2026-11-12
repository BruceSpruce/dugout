// Player attributes and club strength vs. the final table for one imported (league, season). Read-only.
//
// Run:   npm run attributes:report -- --league 39 --season 2024 [--club <name|apiId>]
// Needs: DATABASE_URL in .env.
// Exit:  0 pass (or --club listing), 3 rho / top 6 below threshold, 1 error (usage, unknown club, season not loaded).

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { buildAttributesReport } from "../src/engine/attributes-report";
import * as schema from "../src/server/db/schema";
import { loadAttributesInput } from "../src/server/engine-input/attributes-input";

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
	const club = arg("club");
	if (!Number.isInteger(league) || !Number.isInteger(season)) {
		console.error(
			"Usage: npm run attributes:report -- --league 39 --season 2024 [--club <name|apiId>]",
		);
		return 1;
	}
	const conn = postgres(url);
	try {
		const input = await loadAttributesInput(
			drizzle(conn, { schema }),
			league,
			season,
		);
		if (!input) {
			console.error("Season not loaded — run npm run import:season first");
			return 1;
		}
		const report = buildAttributesReport(
			{ season: `${league}/${season}`, ...input },
			{ club },
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
			`attributes:report error: ${e instanceof Error ? e.message : String(e)}`,
		);
		process.exit(1);
	},
);
