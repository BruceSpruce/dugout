// Guard: player-visible text lives in messages/*.json, not in code. Scans source files of the
// roots below for Polish diacritics outside comments (string and template literals, JSX text
// in src/app). Tests, fixtures and the owner's CLI reports are excluded.
// Limits (accepted): only Polish diacritics are detected, so Polish words without them and
// hard-coded English slip through; src/i18n and src/trpc are not scanned. Review covers the rest.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../..", import.meta.url));

/** Directories to scan (repo-relative). */
const ROOTS = ["src/engine", "src/server", "src/app"];

/** Owner's CLI reports stay Polish (plan: What We're NOT Doing). */
const EXCLUDED_FILES = new Set([
	"src/engine/calibration-report.ts",
	"src/engine/live-calibration.ts",
	"src/engine/attributes-report.ts",
]);

const SOURCE = /\.(ts|tsx)$/;
const TEST = /\.test\.(ts|tsx)$/;
const POLISH = /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/;

function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(join(REPO, dir), { withFileTypes: true })) {
		const path = `${dir}/${entry.name}`;
		if (entry.isDirectory()) {
			if (entry.name !== "__fixtures__") out.push(...sourceFiles(path));
		} else if (
			SOURCE.test(entry.name) &&
			!TEST.test(entry.name) &&
			!EXCLUDED_FILES.has(path)
		) {
			out.push(path);
		}
	}
	return out;
}

/**
 * The source with comments blanked out (newlines kept, so line numbers stay). String and
 * template literals are kept verbatim, so a "//" inside a string is not a comment.
 */
function stripComments(src: string): string {
	let out = "";
	let i = 0;
	while (i < src.length) {
		const ch = src[i] ?? "";
		const next = src[i + 1];
		if (ch === "/" && next === "/") {
			while (i < src.length && src[i] !== "\n") i++;
			continue;
		}
		if (ch === "/" && next === "*") {
			const end = src.indexOf("*/", i + 2);
			const stop = end === -1 ? src.length : end + 2;
			out += src.slice(i, stop).replace(/[^\n]/g, " ");
			i = stop;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			let j = i + 1;
			while (j < src.length && src[j] !== ch) {
				if (src[j] === "\\") j++;
				else if (ch !== "`" && src[j] === "\n") break;
				j++;
			}
			out += src.slice(i, j + 1);
			i = j + 1;
			continue;
		}
		out += ch;
		i++;
	}
	return out;
}

/** "path:line: text" for each line with Polish diacritics outside comments. */
function offenders(path: string): string[] {
	const code = stripComments(readFileSync(join(REPO, path), "utf8"));
	return code
		.split("\n")
		.flatMap((line, n) =>
			POLISH.test(line) ? [`${path}:${n + 1}: ${line.trim()}`] : [],
		);
}

describe("stripComments", () => {
	it("drops comments, keeps literals", () => {
		const src = [
			"// zażółć",
			"/* gęślą",
			"   jaźń */ const a = 1;",
			'const b = "http://x"; // ł',
			"const c = `ó`;",
		].join("\n");
		const out = stripComments(src);
		expect(out.split("\n")).toHaveLength(5);
		expect(out).not.toMatch(/zażółć|gęślą|jaźń|ł$/m);
		expect(out).toContain('"http://x"');
		expect(out).toContain("`ó`");
	});
});

describe("no hard-coded Polish text", () => {
	it.each(ROOTS)("%s: Polish diacritics only in comments", (root) => {
		const files = sourceFiles(root);
		expect(files.length).toBeGreaterThan(0);
		expect(files.flatMap(offenders)).toEqual([]);
	});
});
