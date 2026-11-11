// Load stage of the PL season import: normalizes the raw files from
// .data/api-football/<league>/<season>/ and upserts them into the database (one transaction).
// Idempotent; refuses incomplete input. Makes no network calls.
//
// Run:   npm run import:load -- --league 39 --season 2024 [--max-page 3]
// Needs: DATABASE_URL in .env.
// Exit:  0 loaded, 1 incomplete input or error.

import { join } from "node:path";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { loadSeason } from "../src/import/api-football/load";
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
	const maxPage = Number(arg("max-page", "3"));
	if (
		!Number.isInteger(league) ||
		!Number.isInteger(season) ||
		!Number.isInteger(maxPage) ||
		maxPage < 1
	) {
		console.error(
			"Usage: npm run import:load -- --league 39 --season 2024 [--max-page 3]",
		);
		return 1;
	}

	const conn = postgres(url);
	try {
		const result = await loadSeason({
			db: drizzle(conn, { schema }),
			league,
			season,
			dataDir: join(".data", "api-football"),
			maxPage,
		});
		console.log(`import:load league=${league} season=${season}`);
		for (const [table, c] of Object.entries(result)) {
			console.log(`  ${table}: inserted=${c.inserted} updated=${c.updated}`);
		}
		return 0;
	} finally {
		await conn.end();
	}
}

main().then(
	(code) => process.exit(code),
	(e: unknown) => {
		console.error(
			`import:load error: ${e instanceof Error ? e.message : String(e)}`,
		);
		process.exit(1);
	},
);
