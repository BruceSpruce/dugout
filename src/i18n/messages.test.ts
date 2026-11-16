import { describe, expect, it } from "vitest";

import en from "../../messages/en.json";
import pl from "../../messages/pl.json";

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ""): Map<string, string> {
	const out = new Map<string, string>();
	for (const [key, value] of Object.entries(tree)) {
		const path = prefix ? `${prefix}.${key}` : key;
		if (typeof value === "string") out.set(path, value);
		else for (const [k, v] of flatten(value, path)) out.set(k, v);
	}
	return out;
}

const BRANCHING = new Set(["plural", "select", "selectordinal"]);

/** Index of the "}" matching the "{" at `open`. */
function matchingBrace(text: string, open: number): number {
	let depth = 0;
	for (let i = open; i < text.length; i++) {
		if (text[i] === "{") depth++;
		else if (text[i] === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}
	throw new Error(`Unbalanced braces in: ${text}`);
}

/** Argument names used in an ICU message, including those inside plural/select branches. */
function icuArgs(message: string): Set<string> {
	const names = new Set<string>();
	let i = 0;
	while (i < message.length) {
		const ch = message[i];
		if (ch === "'" && /[{}#]/.test(message[i + 1] ?? "")) {
			// ICU quoting: '{literal}' — skip to the closing apostrophe.
			const close = message.indexOf("'", i + 1);
			i = close === -1 ? message.length : close + 1;
			continue;
		}
		if (ch !== "{") {
			i++;
			continue;
		}
		const close = matchingBrace(message, i);
		const body = message.slice(i + 1, close);
		const [rawName, rawType] = body.split(",");
		const name = rawName?.trim() ?? "";
		if (name) names.add(name);
		const type = rawType?.trim();
		if (type && BRANCHING.has(type)) {
			// Branches: everything after "name, type," as `selector {content}` pairs.
			const branches = body.slice(body.indexOf(",", body.indexOf(",") + 1) + 1);
			let j = 0;
			while (j < branches.length) {
				const open = branches.indexOf("{", j);
				if (open === -1) break;
				const end = matchingBrace(branches, open);
				for (const n of icuArgs(branches.slice(open + 1, end))) names.add(n);
				j = end + 1;
			}
		}
		i = close + 1;
	}
	return names;
}

describe("icuArgs", () => {
	it("finds simple, typed and nested arguments", () => {
		expect([...icuArgs("Hello")]).toEqual([]);
		expect([...icuArgs("{a} and {b, number}")].sort()).toEqual(["a", "b"]);
		expect(
			[
				...icuArgs(
					"{n, plural, one {# mecz z {club}} few {# mecze} other {# meczów {when}}}",
				),
			].sort(),
		).toEqual(["club", "n", "when"]);
		expect([...icuArgs("'{not}' {real}")]).toEqual(["real"]);
	});
});

describe("messages parity", () => {
	const plFlat = flatten(pl as Tree);
	const enFlat = flatten(en as Tree);

	it("pl.json and en.json have the same keys", () => {
		expect([...plFlat.keys()].sort()).toEqual([...enFlat.keys()].sort());
	});

	it("each key uses the same ICU arguments in both languages", () => {
		for (const [key, enText] of enFlat) {
			const plText = plFlat.get(key);
			if (plText === undefined) continue;
			expect([...icuArgs(plText)].sort(), key).toEqual(
				[...icuArgs(enText)].sort(),
			);
		}
	});
});
