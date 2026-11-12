// One-shot PL season import: fetch -> load -> report for one (league, season).
//
// Run:   npm run import:season -- --league 39 --season 2024 [--max-requests 95] [--max-page 3] [--min-interval-ms 6500]
// Exit:  0 ok, 2 fetch ran out of budget (re-run tomorrow, load not run), 1 error, 3 report warnings.

import { spawnSync } from "node:child_process";

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i > -1 ? process.argv[i + 1] : undefined;
}

function flags(names: string[]): string[] {
	return names.flatMap((n) => {
		const v = arg(n);
		return v === undefined ? [] : [`--${n}`, v];
	});
}

function run(script: string, args: string[]): number {
	const r = spawnSync("npm", ["run", script, "--silent", "--", ...args], {
		stdio: "inherit",
	});
	return r.status ?? 1;
}

function main(): number {
	if (arg("season") === undefined) {
		console.error(
			"Usage: npm run import:season -- --league 39 --season 2024 [--max-requests 95] [--max-page 3] [--min-interval-ms 6500]",
		);
		return 1;
	}
	const common = flags(["league", "season"]);

	console.log("== fetch ==");
	const fetchCode = run("import:fetch", [
		...common,
		...flags(["max-requests", "max-page", "min-interval-ms"]),
	]);
	if (fetchCode === 2) {
		console.log(
			"Fetch ran out of request budget; load skipped. Re-run the same command tomorrow.",
		);
		return 2;
	}
	if (fetchCode !== 0) return 1;

	console.log("== load ==");
	if (run("import:load", [...common, ...flags(["max-page"])]) !== 0) return 1;

	console.log("== report ==");
	return run("import:report", common);
}

process.exit(main());
