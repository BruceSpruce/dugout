"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";

import { FORMATIONS, type FormationId, type Style } from "~/engine/tactics";
import { appErrorOf, type ErrorKey, errorText } from "~/i18n/error-text";
import { isStyle, STYLE_IDS } from "~/i18n/labels";
import { api, type RouterOutputs } from "~/trpc/react";

type MatchView = NonNullable<RouterOutputs["match"]["view"]>;
type ViewEvent = MatchView["events"][number];
type ViewSide = MatchView["home"];

const FULL_TIME = 90;
const FORMATION_IDS = Object.keys(FORMATIONS) as FormationId[];
const SPEEDS = [1, 2, 4] as const;

const TABS = ["feed", "lineups", "others", "table"] as const;
type Tab = (typeof TABS)[number];

const isFormation = (x: string): x is FormationId => x in FORMATIONS;

type MatchT = ReturnType<typeof useTranslations<"match">>;
type LabelsT = ReturnType<typeof useTranslations<"labels">>;

/** Style label; an unknown style id (not expected from the server) is shown as is. */
const styleLabel = (tl: LabelsT, style: string | undefined): string =>
	style && isStyle(style) ? tl(`style.${style}`) : (style ?? "");

const selectClass =
	"rounded bg-[#071a0e] px-2 py-1 text-sm text-white ring-1 ring-white/20 disabled:opacity-50";
const btn =
	"rounded bg-white/15 px-3 py-1.5 text-sm font-semibold hover:bg-white/25 disabled:opacity-50";
const btnActive =
	"rounded bg-green-500 px-3 py-1.5 text-sm font-bold text-[#071a0e]";

function EventIcon({ kind }: { kind: ViewEvent["kind"] }) {
	const t = useTranslations("match");
	switch (kind) {
		case "goal":
			return <span className="font-bold text-white">{t("goalIcon")}</span>;
		case "yellow":
			return <span className="inline-block h-3.5 w-2.5 bg-yellow-400" />;
		case "second-yellow":
			return (
				<span className="inline-flex gap-0.5">
					<span className="inline-block h-3.5 w-2.5 bg-yellow-400" />
					<span className="inline-block h-3.5 w-2.5 bg-red-500" />
				</span>
			);
		case "red":
			return <span className="inline-block h-3.5 w-2.5 bg-red-500" />;
		case "injury":
			return <span className="font-bold text-red-400">+</span>;
		case "sub":
			return <span className="font-bold text-green-300">⇄</span>;
		case "tactic":
			return <span className="font-bold text-green-300">T</span>;
		default:
			return <span className="text-green-200">|</span>;
	}
}

/** Feed line of an event, built from the event data in the player's language. */
function eventText(
	t: MatchT,
	tl: LabelsT,
	e: ViewEvent,
	sideName: string,
): string {
	const player = e.playerName ?? "";
	switch (e.kind) {
		case "goal":
			return t("event.goal", { player, team: sideName });
		case "yellow":
			return t("event.yellow", { player, team: sideName });
		case "second-yellow":
			return t("event.secondYellow", { player, team: sideName });
		case "red":
			return t("event.red", { player, team: sideName });
		case "injury":
			return t("event.injury", { player, team: sideName });
		case "sub":
			return t("event.sub", {
				team: sideName,
				playerIn: e.inPlayerName ?? "?",
				playerOut: e.playerName ?? "?",
				by: e.by ?? "player",
			});
		case "tactic":
			return t("event.tactic", {
				team: sideName,
				formation: e.formation ?? "",
				style: styleLabel(tl, e.style),
			});
		case "half-time":
			return t("event.halfTime");
		case "full-time":
			return t("event.fullTime");
	}
}

function Pitch({ side, title }: { side: ViewSide; title: string }) {
	const t = useTranslations("match");
	const tl = useTranslations("labels");
	return (
		<div className="rounded-lg bg-white/10 p-3">
			<h3 className="mb-1 font-bold">
				{title}: {side.name}{" "}
				<span className="font-normal text-green-200">
					({side.tactic.formation}, {styleLabel(tl, side.tactic.style)})
				</span>
			</h3>
			<ul className="text-sm">
				{side.slots.map((s, i) => (
					<li
						className="flex justify-between gap-2 border-t border-white/10 py-0.5 first:border-t-0"
						// biome-ignore lint/suspicious/noArrayIndexKey: positional formation slots
						key={i}
					>
						<span>
							<span className="mr-2 inline-block w-8 text-green-200">
								{tl(`role.${s.role}`)}
							</span>
							{s.player ? (
								s.player.name
							) : (
								<span className="text-red-300">{t("emptySlot")}</span>
							)}
						</span>
						<span className="text-green-100 tabular-nums">
							{s.condition !== null ? `${Math.round(s.condition)}%` : ""}
						</span>
					</li>
				))}
			</ul>
			<div className="mt-2 text-xs text-green-200">{t("bench")}</div>
			<ul className="text-sm">
				{side.bench.map((p) => (
					<li className="flex justify-between gap-2" key={p.playerId}>
						<span>{p.name}</span>
						<span className="text-green-100 tabular-nums">
							{tl(`position.${p.position}`)}
						</span>
					</li>
				))}
			</ul>
		</div>
	);
}

export function MatchScreen({ gameId }: { gameId: number }) {
	const router = useRouter();
	const t = useTranslations();
	const tm = useTranslations("match");
	const tl = useTranslations("labels");
	const utils = api.useUtils();
	const query = api.match.view.useQuery(
		{ gameId },
		{ refetchOnWindowFocus: false, staleTime: Number.POSITIVE_INFINITY },
	);
	const start = api.match.start.useMutation();
	const advance = api.match.advance.useMutation();
	const change = api.match.change.useMutation();
	const finish = api.match.finish.useMutation();
	const exit = api.match.exit.useMutation();

	const view = query.data ?? null;
	const [tab, setTab] = useState<Tab>("feed");
	const [playing, setPlaying] = useState(false);
	const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
	/** Injury that stopped the clock (translated at render, so it follows the language). */
	const [notice, setNotice] = useState<{
		player: string | null;
		minute: number;
	} | null>(null);
	/** The raw error (translated at render) and the text for an error without a code. */
	const [error, setError] = useState<{
		cause: unknown;
		fallback: ErrorKey;
	} | null>(null);
	const errorMessage = error ? errorText(t, error.cause, error.fallback) : null;
	const [confirmExit, setConfirmExit] = useState(false);
	/** Potwierdź pressed: disables both buttons until exit fails (double click guard). */
	const [exitStarted, setExitStarted] = useState(false);
	const [outId, setOutId] = useState("");
	const [inId, setInId] = useState("");
	const [formation, setFormation] = useState<FormationId>("4-4-2");
	const [style, setStyle] = useState<Style>("balanced");

	const viewRef = useRef<MatchView | null>(null);
	viewRef.current = view;
	const inflight = useRef(false);
	/** Exit confirmed: no further ticks may start. */
	const exiting = useRef(false);
	/** "Do końca" pressed while a tick was in flight: run it when the tick returns. */
	const pendingTarget = useRef<number | null>(null);
	const seenInjuries = useRef<Set<string> | null>(null);

	const publish = useCallback(
		(v: MatchView) => {
			utils.match.view.setData({ gameId }, v);
		},
		[utils, gameId],
	);

	// Auto-pause when a player of the user's club is injured (events seen on load do not count).
	useEffect(() => {
		if (!view) return;
		const injuries = view.events.filter(
			(e) => e.kind === "injury" && e.side === view.userSide,
		);
		const keys = injuries.map((e) => `${e.minute}-${e.playerId}`);
		if (seenInjuries.current === null) {
			seenInjuries.current = new Set(keys);
			return;
		}
		const fresh = injuries.filter(
			(e) => !seenInjuries.current?.has(`${e.minute}-${e.playerId}`),
		);
		for (const k of keys) seenInjuries.current.add(k);
		const first = fresh[0];
		if (first && view.minute < FULL_TIME) {
			setPlaying(false);
			setNotice({ player: first.playerName ?? null, minute: first.minute });
			setTab("lineups");
		}
	}, [view]);

	const userTactic = view?.userSide ? view[view.userSide].tactic : null;
	const tacticFormation = userTactic?.formation;
	const tacticStyle = userTactic?.style;
	useEffect(() => {
		if (tacticFormation) setFormation(tacticFormation);
		if (tacticStyle) setStyle(tacticStyle);
	}, [tacticFormation, tacticStyle]);

	const run = useCallback(
		async (toMinute: number) => {
			if (exiting.current) return;
			if (inflight.current) {
				if (toMinute >= FULL_TIME) pendingTarget.current = toMinute;
				return;
			}
			inflight.current = true;
			setError(null);
			try {
				const next = await advance.mutateAsync({ gameId, toMinute });
				publish(next);
				if (next.minute >= FULL_TIME) setPlaying(false);
			} catch (e) {
				setPlaying(false);
				setError({ cause: e, fallback: "advanceFailed" });
			} finally {
				inflight.current = false;
				const pending = pendingTarget.current;
				pendingTarget.current = null;
				if (pending !== null) void runRef.current(pending);
			}
		},
		[advance, gameId, publish],
	);
	const runRef = useRef(run);
	runRef.current = run;

	useEffect(() => {
		if (!playing) return;
		const t = setInterval(() => {
			const v = viewRef.current;
			if (exiting.current || !v || v.minute >= FULL_TIME) return;
			void runRef.current(v.minute + 1);
		}, 1000 / speed);
		return () => clearInterval(t);
	}, [playing, speed]);

	const onStart = async () => {
		setError(null);
		try {
			publish(await start.mutateAsync({ gameId }));
		} catch (e) {
			setError({ cause: e, fallback: "startFailed" });
		}
	};

	const onFinish = async () => {
		setError(null);
		try {
			await finish.mutateAsync({ gameId });
			utils.match.view.setData({ gameId }, null);
			router.push(`/game/${gameId}`);
			router.refresh();
		} catch (e) {
			setError({ cause: e, fallback: "finishFailed" });
		}
	};

	const onExit = async () => {
		setError(null);
		setExitStarted(true);
		exiting.current = true;
		setPlaying(false);
		pendingTarget.current = null;
		try {
			while (inflight.current) {
				await new Promise((r) => setTimeout(r, 50));
			}
			await exit.mutateAsync({ gameId });
			utils.match.view.setData({ gameId }, null);
			router.push(`/game/${gameId}`);
			router.refresh();
		} catch (e) {
			exiting.current = false;
			setExitStarted(false);
			setConfirmExit(false);
			setError({ cause: e, fallback: "exitFailed" });
		}
	};

	const onChange = async (
		c:
			| { kind: "sub"; out: number; in: number }
			| { kind: "tactic"; formation: FormationId; style: Style },
	) => {
		setError(null);
		try {
			publish(await change.mutateAsync({ gameId, change: c }));
			if (c.kind === "sub") {
				setOutId("");
				setInId("");
				setNotice(null);
			}
		} catch (e) {
			setError({ cause: e, fallback: "changeFailed" });
		}
	};

	if (query.isLoading) {
		return <p className="text-green-200">{t("common.loading")}</p>;
	}
	if (query.error) {
		return <p className="text-red-300">{errorText(t, query.error)}</p>;
	}

	if (!view) {
		const errorCode = error ? appErrorOf(error.cause)?.code : undefined;
		const skladHint =
			errorCode === "savedLineupInvalid" || errorCode === "playerUnavailable";
		return (
			<section className="flex w-full max-w-4xl flex-col items-start gap-3 rounded-lg bg-white/10 p-6">
				<h1 className="text-2xl font-extrabold">{tm("title")}</h1>
				<p>{tm("noMatch")}</p>
				<button
					className={btnActive}
					disabled={start.isPending}
					onClick={() => void onStart()}
					type="button"
				>
					{tm("startMatch")}
				</button>
				{errorMessage ? (
					<p className="text-red-300">
						{errorMessage}
						{skladHint ? (
							<>
								{" "}
								<Link
									className="text-green-200 underline"
									href={`/game/${gameId}/sklad`}
								>
									{tm("goToLineup")}
								</Link>
							</>
						) : null}
					</p>
				) : null}
			</section>
		);
	}

	const user = view.userSide ? view[view.userSide] : null;
	const ended = view.minute >= FULL_TIME;
	// An open exit confirmation freezes the match controls (Do końca, subs, tactic).
	const busy =
		advance.isPending ||
		change.isPending ||
		finish.isPending ||
		exit.isPending ||
		confirmExit;
	const nameOf = (side: "home" | "away" | null) =>
		side ? view[side].name : "";

	return (
		<div className="flex w-full max-w-4xl flex-col gap-4">
			<section className="rounded-lg bg-white/10 p-4">
				<div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 text-center">
					<div className="text-xl font-bold">{view.home.name}</div>
					<div>
						<div className="text-4xl font-extrabold tabular-nums">
							{view.score.home} : {view.score.away}
						</div>
						<div className="text-green-200 tabular-nums">
							{ended ? tm("ended") : `${view.minute}'`}
						</div>
					</div>
					<div className="text-xl font-bold">{view.away.name}</div>
				</div>
				<div className="mt-4 flex flex-wrap items-center justify-center gap-2">
					{ended ? (
						<button
							className={btnActive}
							disabled={finish.isPending}
							onClick={() => void onFinish()}
							type="button"
						>
							{tm("finishRound")}
						</button>
					) : (
						<>
							<button
								className={playing ? btn : btnActive}
								disabled={start.isPending || confirmExit}
								onClick={() => {
									setNotice(null);
									setPlaying((p) => !p);
								}}
								type="button"
							>
								{playing
									? tm("pause")
									: view.minute === 0
										? tm("kickOff")
										: tm("resume")}
							</button>
							{SPEEDS.map((s) => (
								<button
									className={speed === s ? btnActive : btn}
									key={s}
									onClick={() => setSpeed(s)}
									type="button"
								>
									×{s}
								</button>
							))}
							<button
								className={btn}
								disabled={advance.isPending || confirmExit}
								onClick={() => {
									setPlaying(false);
									setNotice(null);
									void run(FULL_TIME);
								}}
								type="button"
							>
								{tm("toEnd")}
							</button>
							{confirmExit ? (
								<span className="flex flex-wrap items-center gap-2 text-sm text-yellow-300">
									{tm("exitConfirm")}
									<button
										className={btnActive}
										disabled={exitStarted}
										onClick={() => void onExit()}
										type="button"
									>
										{tm("confirm")}
									</button>
									<button
										className={btn}
										disabled={exitStarted}
										onClick={() => setConfirmExit(false)}
										type="button"
									>
										{tm("cancel")}
									</button>
								</span>
							) : (
								<button
									className={btn}
									disabled={busy}
									onClick={() => {
										setPlaying(false);
										setNotice(null);
										setConfirmExit(true);
									}}
									type="button"
								>
									{tm("exit")}
								</button>
							)}
						</>
					)}
				</div>
				{notice ? (
					<p className="mt-3 text-center text-yellow-300">
						{tm("injuryNotice", {
							player: notice.player ?? tm("playerFallback"),
							minute: notice.minute,
						})}
					</p>
				) : null}
				{errorMessage ? (
					<p className="mt-3 text-center text-red-300">{errorMessage}</p>
				) : null}
			</section>

			<nav className="flex gap-1 border-b border-white/20">
				{TABS.map((id) => (
					<button
						className={`px-4 py-2 text-sm font-semibold ${
							tab === id
								? "border-b-2 border-green-400 text-white"
								: "text-green-200 hover:text-white"
						}`}
						key={id}
						onClick={() => setTab(id)}
						type="button"
					>
						{tm(`tab.${id}`)}
					</button>
				))}
			</nav>

			{tab === "feed" ? (
				<section className="rounded-lg bg-white/10 p-4">
					{view.events.length === 0 ? (
						<p className="text-green-200">{tm("noEvents")}</p>
					) : (
						<ul className="flex flex-col">
							{view.events.map((e, i) => (
								<li
									className="flex items-center gap-3 border-t border-white/10 py-1.5 first:border-t-0"
									// biome-ignore lint/suspicious/noArrayIndexKey: events have no unique id
									key={i}
								>
									<span className="w-10 text-right text-green-200 tabular-nums">
										{e.minute}'
									</span>
									<span className="flex w-8 justify-center">
										<EventIcon kind={e.kind} />
									</span>
									<span>{eventText(tm, tl, e, nameOf(e.side))}</span>
								</li>
							))}
						</ul>
					)}
				</section>
			) : null}

			{tab === "lineups" ? (
				<section className="flex flex-col gap-4">
					{user && !ended ? (
						<div className="flex flex-col gap-3 rounded-lg bg-white/10 p-4">
							<div className="flex flex-wrap items-end gap-3">
								<label className="flex flex-col gap-1 text-sm text-green-200">
									{tm("subOut")}
									<select
										className={selectClass}
										onChange={(e) => setOutId(e.target.value)}
										value={outId}
									>
										<option value="">—</option>
										{user.slots.map((s) =>
											s.player ? (
												<option
													key={s.player.playerId}
													value={s.player.playerId}
												>
													{s.player.name} ({Math.round(s.condition ?? 0)}%)
												</option>
											) : null,
										)}
										{user.vacancies.map((playerId) => (
											<option key={playerId} value={playerId}>
												{view.events.find(
													(e) => e.kind === "injury" && e.playerId === playerId,
												)?.playerName ?? tm("playerFallback")}{" "}
												{tm("injured")}
											</option>
										))}
									</select>
								</label>
								<label className="flex flex-col gap-1 text-sm text-green-200">
									{tm("subIn")}
									<select
										className={selectClass}
										onChange={(e) => setInId(e.target.value)}
										value={inId}
									>
										<option value="">—</option>
										{user.bench.map((p) => (
											<option key={p.playerId} value={p.playerId}>
												{p.name} · {tl(`position.${p.position}`)}
											</option>
										))}
									</select>
								</label>
								<button
									className={btnActive}
									disabled={
										busy || outId === "" || inId === "" || user.subsLeft <= 0
									}
									onClick={() =>
										void onChange({
											kind: "sub",
											out: Number(outId),
											in: Number(inId),
										})
									}
									type="button"
								>
									{tm("substitute")}
								</button>
								<span className="text-sm text-green-200">
									{tm("subsLeft", { n: user.subsLeft })}
								</span>
							</div>
							<div className="flex flex-wrap items-end gap-3">
								<label className="flex flex-col gap-1 text-sm text-green-200">
									{tm("formation")}
									<select
										className={selectClass}
										onChange={(e) => {
											if (isFormation(e.target.value))
												setFormation(e.target.value);
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
									{tm("style")}
									<select
										className={selectClass}
										onChange={(e) => {
											if (isStyle(e.target.value)) setStyle(e.target.value);
										}}
										value={style}
									>
										{STYLE_IDS.map((id) => (
											<option key={id} value={id}>
												{tl(`style.${id}`)}
											</option>
										))}
									</select>
								</label>
								<button
									className={btn}
									disabled={busy}
									onClick={() =>
										void onChange({ kind: "tactic", formation, style })
									}
									type="button"
								>
									{tm("applyTactic")}
								</button>
							</div>
							<p className="text-xs text-green-200">
								{tm("changesHint", { minute: view.minute })}
							</p>
						</div>
					) : null}
					<div className="grid gap-4 sm:grid-cols-2">
						<Pitch side={view.home} title={tm("home")} />
						<Pitch side={view.away} title={tm("away")} />
					</div>
				</section>
			) : null}

			{tab === "others" ? (
				<section className="rounded-lg bg-white/10 p-4">
					<ul className="flex flex-col">
						{view.others.map((m) => (
							<li
								className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 border-t border-white/10 py-1.5 first:border-t-0"
								key={m.fixtureId}
							>
								<span className="text-right">{m.home.name}</span>
								<span className="font-bold tabular-nums">
									{m.homeGoals} : {m.awayGoals}
								</span>
								<span>{m.away.name}</span>
							</li>
						))}
					</ul>
				</section>
			) : null}

			{tab === "table" ? (
				<section className="overflow-x-auto rounded-lg bg-white/10 p-4">
					<table className="w-full text-left text-sm">
						<thead className="text-green-200">
							<tr>
								<th className="py-1 pr-2">{t("common.table.position")}</th>
								<th className="py-1 pr-2">{t("common.table.club")}</th>
								<th className="py-1 pr-2 text-right">
									{t("common.table.played")}
								</th>
								<th className="py-1 pr-2 text-right">
									{t("common.table.points")}
								</th>
								<th className="py-1 pr-2 text-right">
									{t("common.table.goalDiff")}
								</th>
								<th className="py-1 text-right">{t("common.table.goals")}</th>
							</tr>
						</thead>
						<tbody>
							{view.table.map((r) => (
								<tr
									className={
										r.clubId === user?.clubId
											? "bg-white/20 font-bold"
											: "border-t border-white/10"
									}
									key={r.clubId}
								>
									<td className="py-1 pr-2">{r.position}</td>
									<td className="py-1 pr-2">{r.name}</td>
									<td className="py-1 pr-2 text-right">{r.played}</td>
									<td className="py-1 pr-2 text-right">{r.points}</td>
									<td className="py-1 pr-2 text-right">{r.goalDiff}</td>
									<td className="py-1 text-right">{r.goalsFor}</td>
								</tr>
							))}
						</tbody>
					</table>
				</section>
			) : null}
		</div>
	);
}
