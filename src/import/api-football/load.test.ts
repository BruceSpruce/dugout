import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IncompleteDataError, readSeasonFiles } from "./load";

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
