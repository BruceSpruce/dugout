import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createTable } from "~/server/db/schema";

describe("createTable", () => {
	it("prefixes table names with dugout_ (drizzle.config.ts tablesFilter relies on it)", () => {
		const t = createTable("smoke", (d) => ({ id: d.integer() }));
		expect(getTableName(t)).toBe("dugout_smoke");
	});
});
