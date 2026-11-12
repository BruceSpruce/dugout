// Daily queue runner: walks the league queue in order with one shared request budget, so a day's
// quota first finishes the current league and then starts the next. Pure orchestration — fetch and
// the load step are injected, which keeps this testable without network or database.

import { BudgetExhaustedError, type Client } from "./client";
import type { FetchSeasonOptions, FetchSeasonResult } from "./fetch";

export type QueueEntry = {
	league: number;
	season: number;
	name: string;
	/** Load into the database once complete (v1: only the playable league). */
	load: boolean;
};

export type EntryState = {
	complete: boolean;
	completedAt?: string;
	loadedAt?: string;
	loadExit?: number;
};

export type DailyState = Record<string, EntryState>;

export type EntryOutcome = {
	key: string;
	name: string;
	requested: number;
	missing: number;
	status: "complete" | "partial" | "skipped";
	loadExit?: number;
};

export type DailyDeps = {
	client: Client;
	dataDir: string;
	maxPage?: number;
	fetchSeason: (o: FetchSeasonOptions) => Promise<FetchSeasonResult>;
	/** Runs load + report for a complete entry; returns the exit code (0 ok, 3 warnings, 1 error). */
	load: (e: QueueEntry) => Promise<number>;
	now?: () => Date;
};

export const entryKey = (e: { league: number; season: number }) =>
	`${e.league}-${e.season}`;

export async function runDaily(
	queue: QueueEntry[],
	state: DailyState,
	deps: DailyDeps,
): Promise<{ outcomes: EntryOutcome[]; state: DailyState }> {
	const now = deps.now ?? (() => new Date());
	const next: DailyState = { ...state };
	const outcomes: EntryOutcome[] = [];
	let budgetLeft = true;

	for (const entry of queue) {
		const key = entryKey(entry);
		const prev = next[key];
		const needsLoad = entry.load && (!prev?.loadedAt || prev.loadExit === 1);
		if (prev?.complete && !needsLoad) {
			outcomes.push({
				key,
				name: entry.name,
				requested: 0,
				missing: 0,
				status: "skipped",
			});
			continue;
		}
		if (!budgetLeft) break;

		let result: FetchSeasonResult;
		try {
			result = await deps.fetchSeason({
				league: entry.league,
				season: entry.season,
				dataDir: deps.dataDir,
				client: deps.client,
				maxPage: deps.maxPage,
			});
		} catch (e) {
			if (e instanceof BudgetExhaustedError) {
				budgetLeft = false;
				break;
			}
			throw e;
		}

		const complete = result.missingAfter.length === 0;
		const outcome: EntryOutcome = {
			key,
			name: entry.name,
			requested: result.requested,
			missing: result.missingAfter.length,
			status: complete ? "complete" : "partial",
		};
		const st: EntryState = { ...prev, complete };
		if (complete && !prev?.complete) st.completedAt = now().toISOString();
		if (complete && entry.load && needsLoad) {
			const code = await deps.load(entry);
			st.loadExit = code;
			if (code !== 1) st.loadedAt = now().toISOString();
			outcome.loadExit = code;
		}
		next[key] = st;
		outcomes.push(outcome);
		// An incomplete entry means the budget ran out inside it: stop for today.
		if (!complete) {
			budgetLeft = false;
			break;
		}
	}
	return { outcomes, state: next };
}

/** One line for the session-start status hook. */
export function statusLine(
	queue: QueueEntry[],
	state: DailyState,
	outcomes: EntryOutcome[],
	at: Date,
	spent: number,
): string {
	const done = queue.filter((e) => state[entryKey(e)]?.complete).length;
	const current = queue.find((e) => !state[entryKey(e)]?.complete);
	const cur = current
		? outcomes.find((o) => o.key === entryKey(current))
		: undefined;
	const pl = queue.find((e) => e.load);
	const plState = pl ? state[entryKey(pl)] : undefined;
	const plText = pl
		? plState?.loadedAt
			? `${pl.name} loaded (report exit ${plState.loadExit})`
			: `${pl.name} not loaded yet`
		: "";
	return [
		`daily-fetch ${at.toISOString().slice(0, 16)}Z`,
		`requests=${spent}`,
		`complete ${done}/${queue.length}`,
		current
			? `current: ${current.name} ${current.season} (missing ${cur?.missing ?? "?"})`
			: "queue done",
		plText,
	]
		.filter(Boolean)
		.join(" | ");
}
