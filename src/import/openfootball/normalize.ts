import type { OpenLeague } from "./leagues";

export type RawMatch = {
	round: string;
	date: string;
	time?: string;
	team1: string;
	team2: string;
	score?: { ht?: number[]; ft?: number[] };
	status?: string;
};
export type RawSeason = { name?: string; matches: RawMatch[] };

export type OpenFixture = {
	sourceKey: string;
	round: number;
	kickoffAt: Date;
	status: "FT" | "NS";
	homeKey: string;
	awayKey: string;
	homeGoals: number | null;
	awayGoals: number | null;
	homeGoalsHt: number | null;
	awayGoalsHt: number | null;
};
export type OpenClub = { sourceKey: string; name: string; country: string };
export type NormalizedOpenSeason = {
	competition: {
		leagueApiId: number;
		season: number;
		name: string;
		country: string;
		startsOn: string;
		endsOn: string;
	};
	clubs: OpenClub[];
	fixtures: OpenFixture[];
	skipped: number;
};

const ROUND_RE = /^(?:Regular, )?Matchday (\d+)$/;

export function slugKey(name: string): string {
	return name
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(timeZone: string): Intl.DateTimeFormat {
	let f = dtfCache.get(timeZone);
	if (!f) {
		f = new Intl.DateTimeFormat("en-US", {
			timeZone,
			hourCycle: "h23",
			year: "numeric",
			month: "numeric",
			day: "numeric",
			hour: "numeric",
			minute: "numeric",
			second: "numeric",
		});
		dtfCache.set(timeZone, f);
	}
	return f;
}

/** Offset (ms) of the zone from UTC at the given instant. */
function offsetAt(ms: number, timeZone: string): number {
	const p: Record<string, number> = {};
	for (const part of dtf(timeZone).formatToParts(new Date(ms))) {
		if (part.type !== "literal") p[part.type] = Number(part.value);
	}
	const asUtc = Date.UTC(
		p.year ?? 0,
		(p.month ?? 1) - 1,
		p.day ?? 1,
		p.hour ?? 0,
		p.minute ?? 0,
		p.second ?? 0,
	);
	return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Local wall-clock date/time in a zone -> UTC instant. */
export function localToUtc(date: string, time: string, timeZone: string): Date {
	const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
	const t = /^(\d{1,2}):(\d{2})$/.exec(time);
	if (!d || !t) throw new Error(`bad date/time: ${date} ${time}`);
	const guess = Date.UTC(
		Number(d[1]),
		Number(d[2]) - 1,
		Number(d[3]),
		Number(t[1]),
		Number(t[2]),
	);
	const o1 = offsetAt(guess, timeZone);
	let utc = guess - o1;
	const o2 = offsetAt(utc, timeZone);
	if (o2 !== o1) utc = guess - o2;
	return new Date(utc);
}

function pair(v: number[] | undefined): [number, number] | null {
	if (v && v.length === 2 && v.every((n) => Number.isInteger(n))) {
		return [v[0] as number, v[1] as number];
	}
	return null;
}

export function normalizeOpenSeason(
	raw: RawSeason,
	league: OpenLeague,
	season: number,
): NormalizedOpenSeason {
	const clubNames = new Map<string, string>();
	const fixtures: OpenFixture[] = [];
	let skipped = 0;

	for (const m of raw.matches) {
		const rm = ROUND_RE.exec(m.round);
		if (!rm) {
			skipped++;
			continue;
		}
		const homeKey = `of:${slugKey(m.team1)}`;
		const awayKey = `of:${slugKey(m.team2)}`;
		clubNames.set(homeKey, m.team1);
		clubNames.set(awayKey, m.team2);
		const ft = pair(m.score?.ft);
		const ht = pair(m.score?.ht);
		fixtures.push({
			sourceKey: `of:${league.code}:${season}:${slugKey(m.team1)}:${slugKey(m.team2)}`,
			round: Number(rm[1]),
			kickoffAt: localToUtc(m.date, m.time ?? "00:00", league.timeZone),
			status: ft ? "FT" : "NS",
			homeKey,
			awayKey,
			homeGoals: ft ? ft[0] : null,
			awayGoals: ft ? ft[1] : null,
			homeGoalsHt: ht ? ht[0] : null,
			awayGoalsHt: ht ? ht[1] : null,
		});
	}

	validateSchedule(league.code, fixtures, [...clubNames.keys()]);

	const dates = raw.matches
		.filter((m) => ROUND_RE.test(m.round))
		.map((m) => m.date)
		.sort();
	return {
		competition: {
			leagueApiId: league.leagueApiId,
			season,
			name: league.name,
			country: league.country,
			startsOn: dates[0] ?? "",
			endsOn: dates[dates.length - 1] ?? "",
		},
		clubs: [...clubNames].map(([sourceKey, name]) => ({
			sourceKey,
			name,
			country: league.country,
		})),
		fixtures,
		skipped,
	};
}

function validateSchedule(
	code: string,
	fixtures: OpenFixture[],
	clubs: string[],
): void {
	const n = 2 * (clubs.length - 1);
	if (clubs.length < 2) throw new Error(`${code}: fewer than 2 clubs`);
	const pairs = new Set<string>();
	const byRound = new Map<number, Set<string>>();
	for (const f of fixtures) {
		if (f.homeKey === f.awayKey) {
			throw new Error(`${code}: club plays itself: ${f.homeKey}`);
		}
		if (f.round < 1 || f.round > n) {
			throw new Error(`${code}: round ${f.round} outside 1..${n}`);
		}
		const pk = `${f.homeKey}|${f.awayKey}`;
		if (pairs.has(pk)) throw new Error(`${code}: duplicate pair ${pk}`);
		pairs.add(pk);
		const seen = byRound.get(f.round) ?? new Set<string>();
		for (const k of [f.homeKey, f.awayKey]) {
			if (seen.has(k)) {
				throw new Error(`${code}: round ${f.round}: ${k} plays twice`);
			}
			seen.add(k);
		}
		byRound.set(f.round, seen);
	}
	for (let r = 1; r <= n; r++) {
		const seen = byRound.get(r);
		const missing = clubs.filter((c) => !seen?.has(c));
		if (missing.length > 0) {
			throw new Error(`${code}: round ${r} lacks: ${missing.join(", ")}`);
		}
	}
	for (const a of clubs) {
		for (const b of clubs) {
			if (a !== b && !pairs.has(`${a}|${b}`)) {
				throw new Error(`${code}: missing pair ${a} vs ${b}`);
			}
		}
	}
}
