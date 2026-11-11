// Drizzle schema. Every table goes through `createTable`, which prefixes names with `dugout_`
// (drizzle.config.ts filters on that prefix). Change the schema via `npm run db:generate` +
// `npm run db:migrate`; migrations live in `drizzle/` and are committed.

import { pgTableCreator } from "drizzle-orm/pg-core";

export const createTable = pgTableCreator((name) => `dugout_${name}`);
