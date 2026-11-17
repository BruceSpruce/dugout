// Attribute / club-strength report: strength ranking next to the final table, or one club's squad.
// Pure module: no imports outside src/engine/ (runs from the CLI for calibration).

import type { PlayerInput } from "./attributes";
import { computeAttributes, type PlayerAttributes } from "./attributes";
import {
	bestEleven,
	clubStrength,
	compareStrengthToTable,
	type FixtureResult,
	leagueTable,
} from "./club-strength";

export type AttributesReportInput = {
	/** Label printed in the header, e.g. "39/2024". */
	season: string;
	players: PlayerInput[];
	clubs: { clubId: number; name: string; apiId: number | null }[];
	results: FixtureResult[];
};

export type AttributesReportOptions = {
	club?: string;
	rhoMin?: number;
	top6Min?: number;
};

export type AttributesReport = { lines: string[]; exitCode: 0 | 1 | 3 };

const POSITION_ORDER = ["Goalkeeper", "Defender", "Midfielder", "Attacker"];
const POSITION_ABBR: Record<string, string> = {
	Goalkeeper: "GK",
	Defender: "DEF",
	Midfielder: "MID",
	Attacker: "ATT",
};
const RANKING_ROWS = 20;

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

function findClub(input: AttributesReportInput, query: string) {
	const q = query.trim().toLowerCase();
	return input.clubs.find(
		(c) => c.name.toLowerCase() === q || String(c.apiId) === q,
	);
}

export function buildAttributesReport(
	input: AttributesReportInput,
	opts: AttributesReportOptions = {},
): AttributesReport {
	const rhoMin = opts.rhoMin ?? 0.7;
	const top6Min = opts.top6Min ?? 4;
	const attrs = computeAttributes(input.players);
	const byClub = new Map<number, PlayerAttributes[]>();
	for (const a of attrs) {
		const list = byClub.get(a.clubId);
		if (list) list.push(a);
		else byClub.set(a.clubId, [a]);
	}

	if (opts.club !== undefined) {
		const club = findClub(input, opts.club);
		if (!club) {
			return { lines: [`Unknown club: ${opts.club}`], exitCode: 1 };
		}
		const squad = byClub.get(club.clubId) ?? [];
		const eleven = new Set(bestEleven(squad).map((p) => p.playerId));
		const rank = (p: PlayerAttributes) => POSITION_ORDER.indexOf(p.position);
		const sorted = [...squad].sort(
			(a, b) =>
				rank(a) - rank(b) || b.overall - a.overall || a.playerId - b.playerId,
		);
		const lines = [
			`${club.name} ${input.season}: squad ${squad.length}, strength ${clubStrength(squad).toFixed(1)} (* = best eleven)`,
			`  ${"player".padEnd(24)} poz  min  ATK KRE OBR BRA DYS OGL`,
		];
		for (const p of sorted) {
			lines.push(
				`${eleven.has(p.playerId) ? "*" : " "} ${p.name.slice(0, 24).padEnd(24)} ${(POSITION_ABBR[p.position] ?? "?").padEnd(4)} ${String(p.minutes).padStart(4)} ${[
					p.attack,
					p.creativity,
					p.defense,
					p.goalkeeping,
					p.discipline,
					p.overall,
				]
					.map((v) => String(v).padStart(3))
					.join(" ")}`,
			);
		}
		return { lines, exitCode: 0 };
	}

	const table = leagueTable(input.results, input.clubs);
	const cmp = compareStrengthToTable(
		input.clubs.map((c) => ({
			clubId: c.clubId,
			strength: clubStrength(byClub.get(c.clubId) ?? []),
		})),
		table,
	);
	const withMinutes = input.players.filter((p) => p.minutes > 0).length;
	const pass = cmp.rho >= rhoMin && cmp.top6Hits >= top6Min;
	const lines = [
		`attributes ${input.season}: players ${withMinutes}/${input.players.length} with minutes, clubs ${input.clubs.length}`,
		`rho=${cmp.rho.toFixed(2)} (min ${rhoMin.toFixed(2)}) top6=${cmp.top6Hits}/6 (min ${top6Min}) → ${pass ? "PASS" : "FAIL"}`,
	];
	for (const r of cmp.rows.slice(0, RANKING_ROWS)) {
		lines.push(
			`${String(r.strengthRank).padStart(2)}. ${r.name.slice(0, 22).padEnd(22)} ${r.strength.toFixed(1).padStart(5)} | tabela ${String(r.tablePosition).padStart(2)}. ${String(r.points).padStart(3)} pkt | Δ ${signed(r.tablePosition - r.strengthRank)}`,
		);
	}
	return { lines, exitCode: pass ? 0 : 3 };
}
