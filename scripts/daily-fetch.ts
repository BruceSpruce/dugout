// Daily league download (run by the systemd user timer, see scripts/systemd/). Walks
// scripts/league-queue.json in order with today's Free quota: finishes the current league, then
// starts the next. Leagues with `load: true` are loaded into the DB and reported once complete.
//
// Run:   npm run daily:fetch [-- --max-requests 95]
// State: .data/api-football/daily-state.json; one-line status: .data/api-football/daily-status.txt
//        (shown by the Claude Code SessionStart hook); history: .data/api-football/daily.log
// A `load: true` league that was first created by `npm run open:load` is fetched but not loaded
// (`loadBlocked` in the state file); remove that field to retry the load.

import { spawnSync } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { createClient } from "../src/import/api-football/client";
import {
	type DailyState,
	type QueueEntry,
	runDaily,
	statusLine,
} from "../src/import/api-football/daily";
import { fetchSeason } from "../src/import/api-football/fetch";
import { isApiLoadBlocked } from "../src/import/api-football/load";
import * as schema from "../src/server/db/schema";

const DATA_DIR = join(".data", "api-football");
const STATE_FILE = join(DATA_DIR, "daily-state.json");
const STATUS_FILE = join(DATA_DIR, "daily-status.txt");
const LOG_FILE = join(DATA_DIR, "daily.log");
const MARGIN = 5;

type Json = Record<string, unknown>;

function arg(name: string, fallback?: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i > -1 ? process.argv[i + 1] : fallback;
}

async function readState(): Promise<DailyState> {
	try {
		return JSON.parse(await readFile(STATE_FILE, "utf8")) as DailyState;
	} catch {
		return {};
	}
}

function npm(script: string, e: QueueEntry): number {
	const r = spawnSync(
		"npm",
		[
			"run",
			"--silent",
			script,
			"--",
			"--league",
			String(e.league),
			"--season",
			String(e.season),
		],
		{ stdio: "inherit" },
	);
	return r.status ?? 1;
}

function loadAndReport(e: QueueEntry): Promise<number> {
	spawnSync("docker", ["start", "dugout-postgres"], { stdio: "ignore" });
	if (npm("import:load", e) !== 0) return Promise.resolve(1);
	return Promise.resolve(npm("import:report", e));
}

async function loadBlocked(e: QueueEntry): Promise<string | null> {
	const url = process.env.DATABASE_URL;
	if (!url) return null; // the load step reports the missing variable
	spawnSync("docker", ["start", "dugout-postgres"], { stdio: "ignore" });
	const conn = postgres(url);
	try {
		return await isApiLoadBlocked(
			drizzle(conn, { schema }),
			e.league,
			e.season,
		);
	} catch {
		return null; // DB down: let the load step fail and retry tomorrow
	} finally {
		await conn.end();
	}
}

async function main(): Promise<number> {
	const apiKey = process.env.API_FOOTBALL_KEY;
	if (!apiKey) {
		console.error("Missing API_FOOTBALL_KEY (add it to .env).");
		return 1;
	}
	const queue = JSON.parse(
		await readFile(join("scripts", "league-queue.json"), "utf8"),
	) as QueueEntry[];
	await mkdir(DATA_DIR, { recursive: true });

	// /status is free; its counter can lag, so keep a margin.
	const probe = createClient({ apiKey, maxRequests: 0 });
	const status = await probe.get("/status");
	const req = (status.response as Json | undefined)?.requests as
		| Json
		| undefined;
	const left = Number(req?.limit_day) - Number(req?.current) - MARGIN;
	const cap = Number(arg("max-requests", "95"));
	const maxRequests = Math.max(
		0,
		Math.min(cap, Number.isFinite(left) ? left : cap),
	);
	console.log(
		`daily-fetch: requests today=${req?.current}/${req?.limit_day} budget=${maxRequests}`,
	);

	const client = createClient({ apiKey, maxRequests, minIntervalMs: 6500 });
	const at = new Date();
	const { outcomes, state } = await runDaily(queue, await readState(), {
		client,
		dataDir: DATA_DIR,
		fetchSeason,
		load: loadAndReport,
		loadBlocked,
	});
	await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);

	const line = statusLine(queue, state, outcomes, at, client.spent);
	await writeFile(STATUS_FILE, `${line}\n`);
	const detail = outcomes
		.filter((o) => o.status !== "skipped")
		.map(
			(o) =>
				`${o.name}: ${o.status} req=${o.requested} missing=${o.missing}${o.loadExit === undefined ? "" : ` load/report exit=${o.loadExit}`}${o.loadBlocked ? ` load skipped: ${o.loadBlocked}` : ""}`,
		)
		.join("; ");
	await appendFile(LOG_FILE, `${line}${detail ? ` || ${detail}` : ""}\n`);
	console.log(line);
	if (detail) console.log(detail);
	return 0;
}

main().then(
	(code) => process.exit(code),
	async (e: unknown) => {
		const msg = `daily-fetch error ${new Date().toISOString().slice(0, 16)}Z: ${e instanceof Error ? e.message : String(e)}`;
		console.error(msg);
		try {
			await mkdir(DATA_DIR, { recursive: true });
			await writeFile(STATUS_FILE, `${msg}\n`);
			await appendFile(LOG_FILE, `${msg}\n`);
		} catch {}
		process.exit(1);
	},
);
