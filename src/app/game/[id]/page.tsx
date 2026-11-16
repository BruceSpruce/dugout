import { TRPCError } from "@trpc/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";

import { api } from "~/trpc/server";

export const dynamic = "force-dynamic";

export default async function GamePage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;
	if (!/^[1-9]\d*$/.test(id)) notFound();
	const gameId = Number(id);
	if (!Number.isSafeInteger(gameId)) notFound();

	await api.match.settle({ gameId });

	let screen: Awaited<ReturnType<typeof api.game.roundScreen>>;
	try {
		screen = await api.game.roundScreen({ gameId });
	} catch (e) {
		if (e instanceof TRPCError && e.code === "NOT_FOUND") notFound();
		throw e;
	}
	const { nextMatch, table, previousRound } = screen;
	const live = await api.match.view({ gameId });
	const t = await getTranslations("round");
	const tc = await getTranslations("common");
	const format = await getFormatter();
	// Time zone comes from the request config (Europe/Warsaw).
	const formatDate = (d: Date) =>
		format.dateTime(d, { dateStyle: "medium", timeStyle: "short" });

	return (
		<main className="flex min-h-screen flex-col items-center gap-8 bg-gradient-to-b from-[#0b3d1f] to-[#071a0e] px-4 py-10 text-white">
			<div className="w-full max-w-3xl">
				<Link className="text-green-200 hover:underline" href="/">
					{t("backToGames")}
				</Link>
				<div className="mt-2 flex items-center justify-between gap-4">
					<h1 className="text-3xl font-extrabold">{screen.clubName}</h1>
					<div className="flex gap-2">
						{screen.seasonNo > 1 ? (
							<Link
								className="rounded bg-white/15 px-3 py-1.5 font-semibold hover:bg-white/25"
								href={`/game/${gameId}/historia`}
							>
								{tc("history")}
							</Link>
						) : null}
						<Link
							className="rounded bg-white/15 px-3 py-1.5 font-semibold hover:bg-white/25"
							href={`/game/${gameId}/sklad`}
						>
							{t("lineup")}
						</Link>
					</div>
				</div>
				<p className="text-green-100">
					{t("seasonRound", {
						season: screen.seasonNo,
						round: screen.round,
						total: screen.totalRounds,
					})}
				</p>
			</div>

			{screen.lastSeason ? (
				<section className="w-full max-w-3xl rounded-lg bg-yellow-400/15 p-4 text-yellow-200">
					<p className="font-semibold">
						{t("seasonOver", {
							season: screen.lastSeason.seasonNo,
							champion: screen.lastSeason.champion,
							position: screen.lastSeason.position,
						})}
					</p>
					<Link
						className="mt-2 inline-block rounded bg-yellow-400 px-3 py-1.5 font-bold text-[#071a0e] hover:bg-yellow-300"
						href={`/game/${gameId}/sezon/${screen.lastSeason.seasonNo}`}
					>
						{t("summary")}
					</Link>
				</section>
			) : null}

			<section className="w-full max-w-3xl rounded-lg bg-white/10 p-4">
				{screen.aiFinished ? (
					<p className="mb-3 rounded bg-yellow-400/15 px-3 py-2 text-yellow-300">
						{t("aiFinished", {
							home: screen.aiFinished.home,
							homeGoals: screen.aiFinished.score.home,
							awayGoals: screen.aiFinished.score.away,
							away: screen.aiFinished.away,
							minute: screen.aiFinished.fromMinute,
						})}
					</p>
				) : null}
				<h2 className="mb-2 text-xl font-bold">{t("nextMatch")}</h2>
				{nextMatch ? (
					<p>
						{t("fixture", {
							opponent: nextMatch.opponent,
							venue: nextMatch.home ? "home" : "away",
							date: formatDate(nextMatch.kickoffAt),
							round: nextMatch.round,
						})}
					</p>
				) : (
					<p>{t("seasonFinished")}</p>
				)}
				{nextMatch ? (
					<Link
						className="mt-3 inline-block rounded bg-green-500 px-4 py-2 font-bold text-[#071a0e] hover:bg-green-400"
						href={`/game/${gameId}/mecz`}
					>
						{live ? t("backToMatch") : t("playMatch")}
					</Link>
				) : null}
			</section>

			<section className="w-full max-w-3xl">
				<h2 className="mb-2 text-xl font-bold">{t("table")}</h2>
				<table className="w-full text-left text-sm">
					<thead className="text-green-200">
						<tr>
							<th className="py-1 pr-2">{tc("table.position")}</th>
							<th className="py-1 pr-2">{tc("table.club")}</th>
							<th className="py-1 pr-2 text-right">{tc("table.played")}</th>
							<th className="py-1 pr-2 text-right">{tc("table.points")}</th>
							<th className="py-1 pr-2 text-right">{tc("table.goalDiff")}</th>
							<th className="py-1 text-right">{tc("table.goals")}</th>
						</tr>
					</thead>
					<tbody>
						{table.map((r) => (
							<tr
								className={
									r.clubId === screen.clubId
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

			<section className="w-full max-w-3xl">
				<h2 className="mb-2 text-xl font-bold">{t("previousRound")}</h2>
				{previousRound ? (
					<ul className="flex flex-col gap-1">
						{previousRound.matches.map((m) => (
							<li key={`${m.home}-${m.away}`}>
								{m.home} {m.homeGoals}:{m.awayGoals} {m.away}
							</li>
						))}
					</ul>
				) : (
					<p>{t("noPreviousRound")}</p>
				)}
			</section>
		</main>
	);
}
