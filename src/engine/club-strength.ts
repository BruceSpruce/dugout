// Club strength from the best eleven, final league table from results, and their rank correlation.
// Pure module: no imports outside src/engine/ (runs from the CLI for calibration).

import type { PlayerAttributes, Position } from "./attributes";

const FORMATION: Record<Position, number> = {
	Goalkeeper: 1,
	Defender: 4,
	Midfielder: 4,
	Attacker: 2,
};
const ELEVEN = 11;
const OUT_OF_POSITION_FACTOR = 0.8;

const byOverallDesc = (a: PlayerAttributes, b: PlayerAttributes) =>
	b.overall - a.overall || a.playerId - b.playerId;

/**
 * Best 1-4-4-2 eleven by overall. Gaps are filled with the best remaining outfield players,
 * returned as copies with overall x 0.8 (unrounded). Fewer than 11 when the squad is too small.
 */
export function bestEleven(squad: PlayerAttributes[]): PlayerAttributes[] {
	const sorted = [...squad].sort(byOverallDesc);
	const picked: PlayerAttributes[] = [];
	const used = new Set<PlayerAttributes>();
	for (const [position, quota] of Object.entries(FORMATION) as [
		Position,
		number,
	][]) {
		for (const p of sorted
			.filter((x) => x.position === position)
			.slice(0, quota)) {
			picked.push(p);
			used.add(p);
		}
	}
	const fillers = sorted
		.filter((p) => !used.has(p) && p.position !== "Goalkeeper")
		.slice(0, ELEVEN - picked.length)
		.map((p) => ({ ...p, overall: p.overall * OUT_OF_POSITION_FACTOR }));
	return [...picked, ...fillers];
}

/** Mean overall of the best eleven, rounded to 1 decimal (0 for an empty squad). */
export function clubStrength(squad: PlayerAttributes[]): number {
	const eleven = bestEleven(squad);
	if (eleven.length === 0) return 0;
	const mean = eleven.reduce((s, p) => s + p.overall, 0) / eleven.length;
	return Math.round(mean * 10) / 10;
}

export type FixtureResult = {
	homeClubId: number;
	awayClubId: number;
	homeGoals: number;
	awayGoals: number;
};

export type TableRow = {
	clubId: number;
	name: string;
	position: number;
	played: number;
	points: number;
	goalDiff: number;
	goalsFor: number;
};

/** Final table: 3/1/0 points, ordered by points, goal difference, goals for, name. */
export function leagueTable(
	results: FixtureResult[],
	clubs: { clubId: number; name: string }[],
): TableRow[] {
	const rows = new Map<number, Omit<TableRow, "position">>();
	for (const c of clubs) {
		rows.set(c.clubId, {
			clubId: c.clubId,
			name: c.name,
			played: 0,
			points: 0,
			goalDiff: 0,
			goalsFor: 0,
		});
	}
	const apply = (id: number, gf: number, ga: number) => {
		const row = rows.get(id);
		if (!row) return;
		row.played += 1;
		row.points += gf > ga ? 3 : gf === ga ? 1 : 0;
		row.goalDiff += gf - ga;
		row.goalsFor += gf;
	};
	for (const r of results) {
		apply(r.homeClubId, r.homeGoals, r.awayGoals);
		apply(r.awayClubId, r.awayGoals, r.homeGoals);
	}
	return [...rows.values()]
		.sort(
			(a, b) =>
				b.points - a.points ||
				b.goalDiff - a.goalDiff ||
				b.goalsFor - a.goalsFor ||
				a.name.localeCompare(b.name),
		)
		.map((r, i) => ({ ...r, position: i + 1 }));
}

/** Ranks 1..n ascending by value; ties get the average of their ranks. */
function averageRanks(values: number[]): number[] {
	const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
	const ranks = new Array<number>(values.length).fill(0);
	let start = 0;
	while (start < order.length) {
		let end = start;
		while (order[end + 1]?.v === order[start]?.v) end++;
		const avg = (start + end) / 2 + 1;
		for (let k = start; k <= end; k++) {
			const item = order[k];
			if (item) ranks[item.i] = avg;
		}
		start = end + 1;
	}
	return ranks;
}

/** Spearman rank correlation (Pearson on average ranks); 0 when either side has no variance. */
export function spearman(a: number[], b: number[]): number {
	if (a.length !== b.length) throw new Error("spearman: length mismatch");
	const n = a.length;
	if (n < 2) return 0;
	const ra = averageRanks(a);
	const rb = averageRanks(b);
	const ma = ra.reduce((s, x) => s + x, 0) / n;
	const mb = rb.reduce((s, x) => s + x, 0) / n;
	let cov = 0;
	let va = 0;
	let vb = 0;
	for (let i = 0; i < n; i++) {
		const da = (ra[i] ?? 0) - ma;
		const db = (rb[i] ?? 0) - mb;
		cov += da * db;
		va += da * da;
		vb += db * db;
	}
	if (va === 0 || vb === 0) return 0;
	return cov / Math.sqrt(va * vb);
}

export type StrengthComparison = {
	rho: number;
	top6Hits: number;
	rows: {
		clubId: number;
		name: string;
		strengthRank: number;
		strength: number;
		tablePosition: number;
		points: number;
	}[];
};

/**
 * Compares strength ranking (1 = strongest) with the table (1 = top), so agreement gives rho > 0.
 * Only clubs present in both inputs are compared; rows are ordered by strengthRank.
 */
export function compareStrengthToTable(
	strengths: { clubId: number; strength: number }[],
	table: TableRow[],
): StrengthComparison {
	const tableById = new Map(table.map((t) => [t.clubId, t]));
	const joined = strengths
		.map((s) => ({ s, t: tableById.get(s.clubId) }))
		.filter((x): x is { s: (typeof strengths)[number]; t: TableRow } => !!x.t)
		.sort((a, b) => b.s.strength - a.s.strength || a.t.position - b.t.position);
	const rows = joined.map(({ s, t }, i) => ({
		clubId: s.clubId,
		name: t.name,
		strengthRank: i + 1,
		strength: s.strength,
		tablePosition: t.position,
		points: t.points,
	}));
	// Negated strength so rank 1 = strongest, matching table position 1 = top.
	const rho = spearman(
		joined.map((x) => -x.s.strength),
		joined.map((x) => x.t.position),
	);
	const topStrength = new Set(
		rows.filter((r) => r.strengthRank <= 6).map((r) => r.clubId),
	);
	const top6Hits = rows.filter(
		(r) => r.tablePosition <= 6 && topStrength.has(r.clubId),
	).length;
	return { rho, top6Hits, rows };
}
