import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PgTable } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { club } from "~/server/db/schema";
import {
	apiLoadBlocked,
	IncompleteDataError,
	readSeasonFiles,
	type Tx,
	upsert,
} from "./load";

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "dugout-load-"));
	await mkdir(join(root, "players"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

const put = (name: string, body: unknown) =>
	writeFile(join(root, name), JSON.stringify(body));

const teams = {
	response: [{ team: { id: 33, name: "A" } }, { team: { id: 34, name: "B" } }],
};
const page = (total: number) => ({
	paging: { current: 1, total },
	response: [],
});

describe("readSeasonFiles", () => {
	it("lists every missing file and nothing else", async () => {
		await put("teams.json", teams);
		await put("players/team-33-page-001.json", page(3));
		await put("players/team-33-page-002.json", page(3));
		const err = await readSeasonFiles(root).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(IncompleteDataError);
		expect((err as IncompleteDataError).missing).toEqual([
			"fixtures.json",
			"players/team-33-page-003.json",
			"players/team-34-page-001.json",
		]);
	});

	it("respects maxPage and accepts a complete set plus player files", async () => {
		await put("teams.json", teams);
		await put("fixtures.json", { response: [] });
		await put("players/team-33-page-001.json", page(57));
		await put("players/team-33-page-002.json", page(57));
		await put("players/team-34-page-001.json", page(1));
		await put("players/player-7.json", page(1));
		const files = await readSeasonFiles(root, 2);
		expect(files.playerPages).toHaveLength(4);
		await expect(readSeasonFiles(root, 3)).rejects.toThrow(/team-33-page-003/);
	});
});

describe("apiLoadBlocked", () => {
	it("blocks a season that has fixtures without api_id", () => {
		expect(apiLoadBlocked({ fixtures: 306, withoutApiId: 306 })).toBe(true);
		expect(apiLoadBlocked({ fixtures: 380, withoutApiId: 1 })).toBe(true);
	});
	it("allows a new season and a pure API season", () => {
		expect(apiLoadBlocked({ fixtures: 0, withoutApiId: 0 })).toBe(false);
		expect(apiLoadBlocked({ fixtures: 380, withoutApiId: 0 })).toBe(false);
	});
});

// Fake transaction: real drizzle query builder, the final statement is captured as SQL.
function captureTx() {
	const real = drizzle(postgres("postgres://u:p@localhost:1/x"));
	const captured: string[] = [];
	const tx = {
		insert: (table: PgTable) => {
			const b = real.insert(table);
			const chain = {
				values: (v: never) => {
					const w = b.values(v);
					return {
						onConflictDoUpdate: (c: never) => {
							const o = w.onConflictDoUpdate(c);
							return {
								returning: (r: never) => {
									captured.push(o.returning(r).toSQL().sql);
									return Promise.resolve([]);
								},
							};
						},
					};
				},
			};
			return chain;
		},
	};
	return { tx: tx as unknown as Tx, captured };
}

describe("upsert keep", () => {
	const row = { apiId: 1, sourceKey: "of:a", name: "A" };
	const setClause = (sqlText: string) =>
		sqlText.split("do update set")[1] ?? "";

	it("skips kept columns in DO UPDATE SET", async () => {
		const { tx, captured } = captureTx();
		await upsert(tx, club, [row], ["apiId"], { keep: ["sourceKey"] });
		const set = setClause(captured[0] ?? "");
		expect(set).toContain('"name" = excluded."name"');
		expect(set).not.toContain("source_key");
	});
	it("updates every non-key column without keep", async () => {
		const { tx, captured } = captureTx();
		await upsert(tx, club, [row], ["apiId"]);
		expect(setClause(captured[0] ?? "")).toContain("source_key");
	});
});
