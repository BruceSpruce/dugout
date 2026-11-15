"use client";

import { useMemo, useRef, useState } from "react";

import type { PlayerAttributes, Position } from "~/engine/attributes";
import {
	FORMATIONS,
	type FormationId,
	ROLE_POSITION,
	type Role,
	type Slot,
	type Style,
	teamRatings,
} from "~/engine/tactics";
import { api } from "~/trpc/react";

type PlayerStatus = {
	fitness: number;
	form: number;
	injuredFor: number;
	suspendedFor: number;
	available: boolean;
	effectiveOverall: number;
};

type SquadPlayer = PlayerAttributes & { status: PlayerStatus };

type Lineup = {
	formation: string;
	style: string;
	starters: number[];
	bench: number[];
};

const BENCH_SIZE = 9;
const STARTERS_SIZE = 11;

const FORMATION_IDS = Object.keys(FORMATIONS) as FormationId[];

const STYLES: { id: Style; label: string }[] = [
	{ id: "attacking", label: "ofensywny" },
	{ id: "balanced", label: "zrównoważony" },
	{ id: "defensive", label: "defensywny" },
];

const ROLE_LABEL: Record<Role, string> = {
	GK: "BR",
	DEF: "OBR",
	DM: "DP",
	CM: "ŚP",
	AM: "OP",
	ST: "NAP",
};

const POSITION_LABEL: Record<Position, string> = {
	Goalkeeper: "BR",
	Defender: "OBR",
	Midfielder: "POM",
	Attacker: "NAP",
};

const GROUPS: { position: Position; label: string }[] = [
	{ position: "Goalkeeper", label: "Bramkarze" },
	{ position: "Defender", label: "Obrońcy" },
	{ position: "Midfielder", label: "Pomocnicy" },
	{ position: "Attacker", label: "Napastnicy" },
];

const isFormation = (x: string): x is FormationId => x in FORMATIONS;
const isStyle = (x: string): x is Style => STYLES.some((s) => s.id === x);

const fmt = (x: number) =>
	(Math.round(x * 10) / 10).toFixed(1).replace(".", ",");

/** Slot rows from attack down to the goalkeeper: consecutive equal roles share a row. */
function pitchRows(formation: FormationId) {
	const rows: { role: Role; indices: number[] }[] = [];
	for (const [i, role] of FORMATIONS[formation].entries()) {
		const last = rows[rows.length - 1];
		if (last && last.role === role) last.indices.push(i);
		else rows.push({ role, indices: [i] });
	}
	return rows.reverse();
}

/** Fixed 11-length slot array: the i-th id sits in the i-th slot, null = empty slot. */
function padStarters(starters: number[]): (number | null)[] {
	return Array.from({ length: STARTERS_SIZE }, (_, i) => starters[i] ?? null);
}

function padBench(bench: number[]): (number | null)[] {
	return Array.from({ length: BENCH_SIZE }, (_, i) => bench[i] ?? null);
}

const matchesWord = (n: number) =>
	n === 1
		? "mecz"
		: n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)
			? "mecze"
			: "meczów";

/** Short absence note ("kontuzja 2 mecze, pauza 1 mecz"); empty when available. */
function absence(s: PlayerStatus): string {
	const parts: string[] = [];
	if (s.injuredFor > 0) {
		parts.push(`kontuzja ${s.injuredFor} ${matchesWord(s.injuredFor)}`);
	}
	if (s.suspendedFor > 0) {
		parts.push(`pauza ${s.suspendedFor} ${matchesWord(s.suspendedFor)}`);
	}
	return parts.join(", ");
}

function PlayerOptions({ squad, role }: { squad: SquadPlayer[]; role?: Role }) {
	return GROUPS.map((g) => (
		<optgroup key={g.position} label={g.label}>
			{squad
				.filter((p) => p.position === g.position)
				.map((p) => (
					<option
						disabled={!p.status.available}
						key={p.playerId}
						value={p.playerId}
					>
						{p.name} · {p.overall}
						{role && ROLE_POSITION[role] !== p.position ? " ×0,8" : ""}
						{p.status.available ? "" : ` (${absence(p.status)})`}
					</option>
				))}
		</optgroup>
	));
}

const selectClass =
	"w-full rounded bg-[#071a0e]/80 px-1 py-0.5 text-xs text-white ring-1 ring-white/20";

export function LineupEditor({
	gameId,
	squad,
	saved,
	proposal,
}: {
	gameId: number;
	squad: SquadPlayer[];
	saved: Lineup | null;
	proposal: Lineup;
}) {
	const initial = saved ?? proposal;
	const [formation, setFormation] = useState<FormationId>(
		isFormation(initial.formation) ? initial.formation : "4-4-2",
	);
	const [style, setStyle] = useState<Style>(
		isStyle(initial.style) ? initial.style : "balanced",
	);
	const [starters, setStarters] = useState<(number | null)[]>(
		padStarters(initial.starters),
	);
	const [bench, setBench] = useState<(number | null)[]>(
		padBench(initial.bench),
	);
	const [busy, setBusy] = useState(false);
	const [aiError, setAiError] = useState<string | null>(null);
	const [clientError, setClientError] = useState<string | null>(null);
	const requestId = useRef(0);

	const utils = api.useUtils();
	const save = api.game.saveLineup.useMutation();

	const byId = useMemo(
		() => new Map(squad.map((p) => [p.playerId, p])),
		[squad],
	);

	const slots: Slot[] = FORMATIONS[formation].map((role, i) => ({
		role,
		player: byId.get(starters[i] ?? -1) ?? null,
	}));
	const ratings = teamRatings(slots, { formation, style });

	const starterSet = new Set(starters.filter((x): x is number => x !== null));
	const benchSet = new Set(bench.filter((x): x is number => x !== null));

	const touch = () => {
		if (save.isSuccess || save.isError) save.reset();
		setClientError(null);
	};

	/** Put `playerId` into the target spot; its previous occupant takes the player's old place. */
	const place = (
		target: "starter" | "bench",
		index: number,
		playerId: number,
	) => {
		touch();
		const nextStarters = [...starters];
		const nextBench = [...bench];
		const lists = { starter: nextStarters, bench: nextBench } as const;
		const previous = lists[target][index] ?? null;
		const fromStarter = nextStarters.indexOf(playerId);
		const fromBench = nextBench.indexOf(playerId);
		// a starter cannot be moved onto an empty bench spot: it would leave its slot empty
		if (fromStarter >= 0 && previous === null && target === "bench") return;
		if (fromStarter >= 0) nextStarters[fromStarter] = previous;
		if (fromBench >= 0) nextBench[fromBench] = previous;
		lists[target][index] = playerId;
		// a bench player moved into a starter slot frees only the bench
		setStarters(nextStarters);
		setBench(nextBench);
	};

	const clearBench = (index: number) => {
		touch();
		setBench(bench.map((x, i) => (i === index ? null : x)));
	};

	const applyProposal = (p: Lineup) => {
		setStarters(padStarters(p.starters));
		setBench(padBench(p.bench));
	};

	/** Only the latest request applies its result; stale responses are ignored. */
	const run = async (job: (isLatest: () => boolean) => Promise<void>) => {
		const id = ++requestId.current;
		const isLatest = () => requestId.current === id;
		setBusy(true);
		setAiError(null);
		try {
			await job(isLatest);
		} catch (e) {
			if (isLatest()) {
				setAiError(
					e instanceof Error ? e.message : "Nie udało się pobrać propozycji",
				);
			}
		} finally {
			if (isLatest()) setBusy(false);
		}
	};

	const aiProposal = () =>
		run(async (isLatest) => {
			touch();
			const ai = await utils.game.aiLineup.fetch({ gameId, formation });
			if (isLatest()) applyProposal(ai);
		});

	const changeFormation = (next: FormationId) =>
		run(async (isLatest) => {
			touch();
			const ai = await utils.game.aiLineup.fetch({ gameId, formation: next });
			if (!isLatest()) return;
			const used = new Set<number>();
			const pool = starters.filter(
				(id): id is number => id !== null && byId.has(id),
			);
			const roles = FORMATIONS[next];
			const result: (number | null)[] = roles.map((role) => {
				const hit = pool.find(
					(id) =>
						!used.has(id) && byId.get(id)?.position === ROLE_POSITION[role],
				);
				if (hit !== undefined) used.add(hit);
				return hit ?? null;
			});
			for (const [i, v] of result.entries()) {
				if (v !== null) continue;
				const fill =
					ai.starters[i] !== undefined && !used.has(ai.starters[i])
						? ai.starters[i]
						: ai.starters.find((id) => !used.has(id));
				if (fill !== undefined) {
					used.add(fill);
					result[i] = fill;
				}
			}
			const taken = new Set(result.filter((x): x is number => x !== null));
			const candidates = [
				...bench.filter((x): x is number => x !== null),
				...starters.filter((x): x is number => x !== null),
				...ai.bench,
				...ai.starters,
			];
			const nextBench: number[] = [];
			for (const id of candidates) {
				if (nextBench.length >= BENCH_SIZE) break;
				if (taken.has(id) || nextBench.includes(id) || !byId.has(id)) continue;
				nextBench.push(id);
			}
			setFormation(next);
			setStarters(result);
			setBench(padBench(nextBench));
		});

	const submit = () => {
		const filled = starters.filter((x): x is number => x !== null);
		if (filled.length !== STARTERS_SIZE) {
			setClientError("Skład musi mieć 11 zawodników");
			return;
		}
		setClientError(null);
		save.mutate({
			gameId,
			formation,
			style,
			starters: filled,
			bench: bench.filter((x): x is number => x !== null),
		});
	};

	return (
		<div className="flex w-full max-w-4xl flex-col gap-6">
			<section className="flex flex-wrap items-end gap-4 rounded-lg bg-white/10 p-4">
				<label className="flex flex-col gap-1 text-sm text-green-200">
					Formacja
					<select
						className="rounded bg-[#071a0e] px-2 py-1 text-white ring-1 ring-white/20"
						disabled={busy}
						onChange={(e) => {
							const v = e.target.value;
							if (isFormation(v)) void changeFormation(v);
						}}
						value={formation}
					>
						{FORMATION_IDS.map((f) => (
							<option key={f} value={f}>
								{f}
							</option>
						))}
					</select>
				</label>
				<label className="flex flex-col gap-1 text-sm text-green-200">
					Styl gry
					<select
						className="rounded bg-[#071a0e] px-2 py-1 text-white ring-1 ring-white/20"
						disabled={busy}
						onChange={(e) => {
							const v = e.target.value;
							if (isStyle(v)) {
								touch();
								setStyle(v);
							}
						}}
						value={style}
					>
						{STYLES.map((s) => (
							<option key={s.id} value={s.id}>
								{s.label}
							</option>
						))}
					</select>
				</label>
				<button
					className="rounded bg-white/15 px-3 py-1.5 text-sm font-semibold hover:bg-white/25 disabled:opacity-50"
					disabled={busy}
					onClick={() => void aiProposal()}
					type="button"
				>
					Propozycja AI
				</button>
				<div className="ml-auto text-right text-sm">
					<div className="text-green-200">Atak / Obrona</div>
					<div className="text-xl font-bold tabular-nums">
						{fmt(ratings.attack)} / {fmt(ratings.defense)}
					</div>
				</div>
			</section>

			<section className="flex flex-col gap-3 rounded-lg bg-green-800/40 p-3 ring-1 ring-white/15">
				{pitchRows(formation).map((row) => (
					<div
						className="flex justify-around gap-2"
						key={`${row.role}-${row.indices[0]}`}
					>
						{row.indices.map((i) => {
							const p = byId.get(starters[i] ?? -1);
							return (
								<div
									className="flex w-32 flex-col gap-1 rounded-md bg-black/30 p-1.5"
									key={i}
								>
									<div className="flex items-center justify-between text-[11px] text-green-200">
										<span className="font-bold">{ROLE_LABEL[row.role]}</span>
										<span className="tabular-nums">{p ? p.overall : "—"}</span>
									</div>
									<select
										aria-label={`Slot ${ROLE_LABEL[row.role]} ${i}`}
										className={selectClass}
										disabled={busy}
										onChange={(e) => {
											const v = e.target.value;
											if (v !== "") place("starter", i, Number(v));
										}}
										value={starters[i] ?? ""}
									>
										<option value="">—</option>
										<PlayerOptions role={row.role} squad={squad} />
									</select>
								</div>
							);
						})}
					</div>
				))}
			</section>

			<section className="rounded-lg bg-white/10 p-4">
				<h2 className="mb-2 text-lg font-bold">Ławka</h2>
				<div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
					{bench.map((id, i) => (
						<select
							aria-label={`Ławka ${i + 1}`}
							className={selectClass}
							disabled={busy}
							// biome-ignore lint/suspicious/noArrayIndexKey: fixed-size list of positional slots
							key={i}
							onChange={(e) => {
								const v = e.target.value;
								if (v === "") clearBench(i);
								else place("bench", i, Number(v));
							}}
							value={id ?? ""}
						>
							<option value="">—</option>
							<PlayerOptions squad={squad} />
						</select>
					))}
				</div>
			</section>

			<section className="flex flex-wrap items-center gap-3">
				<button
					className="rounded bg-green-500 px-5 py-2 font-bold text-[#071a0e] hover:bg-green-400 disabled:opacity-50"
					disabled={save.isPending || busy}
					onClick={submit}
					type="button"
				>
					Zapisz
				</button>
				{save.isSuccess ? (
					<span className="text-green-200">Zapisano</span>
				) : null}
				{save.error ? (
					<span className="text-red-300">{save.error.message}</span>
				) : null}
				{aiError ? <span className="text-red-300">{aiError}</span> : null}
				{clientError ? (
					<span className="text-red-300">{clientError}</span>
				) : null}
			</section>

			<section>
				<h2 className="mb-2 text-lg font-bold">Kadra</h2>
				<div className="overflow-x-auto">
					<table className="w-full text-left text-sm">
						<thead className="text-green-200">
							<tr>
								<th className="py-1 pr-2">Poz.</th>
								<th className="py-1 pr-2">Zawodnik</th>
								<th className="py-1 pr-2 text-right">Min</th>
								<th className="py-1 pr-2 text-right">ATK</th>
								<th className="py-1 pr-2 text-right">KRE</th>
								<th className="py-1 pr-2 text-right">OBR</th>
								<th className="py-1 pr-2 text-right">BRA</th>
								<th className="py-1 pr-2 text-right">DYS</th>
								<th className="py-1 pr-2 text-right">OGL</th>
								<th className="py-1 pr-2 text-right">Kond.</th>
								<th className="py-1">Status</th>
							</tr>
						</thead>
						<tbody>
							{squad.map((p) => {
								const status = starterSet.has(p.playerId)
									? "skład"
									: benchSet.has(p.playerId)
										? "ławka"
										: "";
								return (
									<tr
										className={`${
											status === "skład"
												? "bg-white/20 font-semibold"
												: "border-t border-white/10"
										} ${p.status.available ? "" : "text-red-300/80"}`}
										key={p.playerId}
									>
										<td className="py-1 pr-2">{POSITION_LABEL[p.position]}</td>
										<td className="py-1 pr-2">{p.name}</td>
										<td className="py-1 pr-2 text-right tabular-nums">
											{p.minutes}
										</td>
										<td className="py-1 pr-2 text-right tabular-nums">
											{p.attack}
										</td>
										<td className="py-1 pr-2 text-right tabular-nums">
											{p.creativity}
										</td>
										<td className="py-1 pr-2 text-right tabular-nums">
											{p.defense}
										</td>
										<td className="py-1 pr-2 text-right tabular-nums">
											{p.goalkeeping}
										</td>
										<td className="py-1 pr-2 text-right tabular-nums">
											{p.discipline}
										</td>
										<td className="py-1 pr-2 text-right font-bold tabular-nums">
											{p.overall}
										</td>
										<td className="py-1 pr-2 text-right tabular-nums">
											{Math.round(p.status.fitness)}%
										</td>
										<td className="py-1">
											{p.status.available ? (
												status
											) : (
												<span className="font-semibold text-red-300">
													{absence(p.status)}
												</span>
											)}
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			</section>
		</div>
	);
}
