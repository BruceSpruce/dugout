// Completeness report for one imported (league, season). Read-only.
//
// Run:   npm run import:report -- --league 39 --season 2024
// Needs: DATABASE_URL in .env.
// Exit:  0 no warnings (section 8 empty), 3 warnings (report still printed in full), 1 error.

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import {
	buildReport,
	queryAggregates,
} from "../src/import/api-football/report";
import * as schema from "../src/server/db/schema";

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
	if (!Number.isInteger(league) || !Number.isInteger(season)) {
		console.error("Usage: npm run import:report -- --league 39 --season 2024");
		return 1;
	}
	const conn = postgres(url);
	try {
		const agg = await queryAggregates(
			drizzle(conn, { schema }),
			league,
			season,
		);
		const report = buildReport(agg);
		console.log(`import:report league=${league} season=${season}`);
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
			`import:report error: ${e instanceof Error ? e.message : String(e)}`,
		);
		process.exit(1);
	},
);
