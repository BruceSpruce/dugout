// Load stage of the openfootball import: reads data/openfootball/2024-25/<code>.json,
// normalizes it and writes leagues, clubs and fixtures to the database (one transaction per
// league). Idempotent. A league already loaded from API-Football (PL) is only matched.
// Makes no network calls.
//
// Run:   npm run open:load [-- --league en.1]   (default: all 8 leagues)
// Needs: DATABASE_URL in .env.
// Exit:  0 loaded, 1 error.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { OPEN_LEAGUES, OPEN_SEASON } from "../src/import/openfootball/leagues";
import { loadOpenSeason } from "../src/import/openfootball/load";
import {
	normalizeOpenSeason,
	type RawSeason,
} from "../src/import/openfootball/normalize";
import * as schema from "../src/server/db/schema";

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i > -1 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
	const url = process.env.DATABASE_URL;
	if (!url) {
		console.error("Missing DATABASE_URL (add it to .env).");
		return 1;
	}
	const code = arg("league");
	const leagues = code
		? OPEN_LEAGUES.filter((l) => l.code === code)
		: OPEN_LEAGUES;
	if (leagues.length === 0) {
		console.error(
			`Unknown league "${code}". Known: ${OPEN_LEAGUES.map((l) => l.code).join(", ")}`,
		);
		return 1;
	}

	const conn = postgres(url);
	const db = drizzle(conn, { schema });
	let failed = false;
	try {
		for (const league of leagues) {
			try {
				const raw = JSON.parse(
					await readFile(
						join("data", "openfootball", "2024-25", `${league.code}.json`),
						"utf8",
					),
				) as RawSeason;
				const n = normalizeOpenSeason(raw, league, OPEN_SEASON);
				const r = await loadOpenSeason(db, n);
				if (r.mode === "matched")
					console.log(`${league.code}: matched clubs=${r.clubs}`);
				else
					console.log(
						`${league.code}: created clubs=+${r.clubs.inserted}/~${r.clubs.updated} fixtures=+${r.fixtures.inserted}/~${r.fixtures.updated} skipped=${r.skipped}`,
					);
			} catch (e) {
				failed = true;
				console.error(
					`${league.code}: error: ${e instanceof Error ? e.message : String(e)}`,
				);
			}
		}
	} finally {
		await conn.end();
	}
	return failed ? 1 : 0;
}

main().then(
	(code) => process.exit(code),
	(e: unknown) => {
		console.error(
			`open:load error: ${e instanceof Error ? e.message : String(e)}`,
		);
		process.exit(1);
	},
);
