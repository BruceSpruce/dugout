// Fetch stage of the PL season import: downloads raw API-Football responses for one league/season
// into .data/api-football/<league>/<season>/. Resumable; existing files are skipped.
//
// Run:   npm run import:fetch -- --league 39 --season 2024 [--max-requests 95] [--max-page 3] [--min-interval-ms 6500]
// Needs: API_FOOTBALL_KEY in .env. /status is free; the rest counts toward the daily quota.
// Exit:  0 everything fetched, 2 budget ran out (resume later), 1 plan/key/network error.

import { join } from "node:path";

import {
	ApiHttpError,
	ApiPlanError,
	createClient,
} from "../src/import/api-football/client";
import { fetchSeason } from "../src/import/api-football/fetch";

type Json = Record<string, unknown>;

function arg(name: string, fallback?: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i > -1 ? process.argv[i + 1] : fallback;
}

async function main(): Promise<number> {
	const apiKey = process.env.API_FOOTBALL_KEY;
	if (!apiKey) {
		console.error("Missing API_FOOTBALL_KEY (add it to .env).");
		return 1;
	}
	const league = Number(arg("league", "39"));
	const season = Number(arg("season"));
	const maxRequests = Number(arg("max-requests", "95"));
	const maxPage = Number(arg("max-page", "3"));
	// Free plan: ~10 requests/minute; 6.5 s between counted requests stays under it.
	const minIntervalMs = Number(arg("min-interval-ms", "6500"));
	if (
		!Number.isInteger(league) ||
		!Number.isInteger(season) ||
		!maxRequests ||
		!Number.isInteger(maxPage) ||
		maxPage < 1 ||
		!Number.isFinite(minIntervalMs) ||
		minIntervalMs < 0
	) {
		console.error(
			"Usage: npm run import:fetch -- --league 39 --season 2024 [--max-requests 95] [--max-page 3] [--min-interval-ms 6500]",
		);
		return 1;
	}

	const client = createClient({ apiKey, maxRequests, minIntervalMs });

	// ad 1. Account and quota (free call).
	const status = await client.get("/status");
	const resp = status.response as Json | undefined;
	const sub = resp?.subscription as Json | undefined;
	const req = resp?.requests as Json | undefined;
	console.log(
		`1. plan=${sub?.plan} requests today=${req?.current}/${req?.limit_day} budget=${maxRequests}`,
	);
	const left = Number(req?.limit_day) - Number(req?.current);
	if (Number.isFinite(left) && left < maxRequests) {
		console.log(
			`   WARNING: only ${left} requests left today, below budget ${maxRequests}`,
		);
	}

	// ad 2. Fetch what is missing.
	const result = await fetchSeason({
		league,
		season,
		dataDir: join(".data", "api-football"),
		client,
		maxPage,
	});
	console.log(
		`2. league=${league} season=${season} requested=${result.requested} skipped=${result.skipped} missing=${result.missingAfter.length}`,
	);
	console.log(
		`   teams needing per-fixture fallback (pages > ${maxPage}): ${result.fallbackTeams}`,
	);
	console.log(
		`3. requests spent=${client.spent} remaining(header)=${client.remaining ?? "n/a"}`,
	);
	if (result.missingAfter.length > 0) {
		console.log(
			`   budget ran out; missing: ${result.missingAfter.slice(0, 10).join(", ")}${result.missingAfter.length > 10 ? ", ..." : ""}`,
		);
		console.log("   Re-run the same command to resume (e.g. tomorrow).");
		return 2;
	}
	return 0;
}

main().then(
	(code) => process.exit(code),
	(e: unknown) => {
		const kind =
			e instanceof ApiPlanError
				? "plan error"
				: e instanceof ApiHttpError
					? "http error"
					: "error";
		console.error(
			`import:fetch ${kind}: ${e instanceof Error ? e.message : String(e)}`,
		);
		process.exit(1);
	},
);
