import { TRPCError } from "@trpc/server";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";

import { api } from "~/trpc/server";

export const dynamic = "force-dynamic";

const MAX_INT = 2147483647;

export default async function SeasonSummaryPage({
	params,
}: {
	params: Promise<{ id: string; n: string }>;
}) {
	const { id, n } = await params;
	if (!/^[1-9]\d*$/.test(id) || !/^[1-9]\d*$/.test(n)) notFound();
	const gameId = Number(id);
	const seasonNo = Number(n);
	// Postgres integer range, as in the router's zod schema: larger ids are a 404, not a 500.
	if (gameId > MAX_INT || seasonNo > MAX_INT) notFound();

	// The AI finished an abandoned match: the round screen shows the notice.
	const { settled } = await api.match.settle({ gameId });
	if (settled) redirect(`/game/${gameId}`);

	let data: Awaited<ReturnType<typeof api.game.season>>;
	try {
		data = await api.game.season({ gameId, seasonNo });
	} catch (e) {
		if (e instanceof TRPCError && e.code === "NOT_FOUND") notFound();
		throw e;
	}
	const { user, stats, table, userClubId } = data;
	const t = await getTranslations("season");
	const tc = await getTranslations("common");
	const format = await getFormatter();
	/** Decimal in the player's language, fixed digits. */
	const num = (v: number, digits: number) =>
		format.number(v, {
			minimumFractionDigits: digits,
			maximumFractionDigits: digits,
		});

	return (
		<main className="flex min-h-screen flex-col items-center gap-8 bg-gradient-to-b from-[#0b3d1f] to-[#071a0e] px-4 py-10 text-white">
			<div className="w-full max-w-3xl">
				<div className="flex items-center justify-between gap-4">
					<Link className="text-green-200 hover:underline" href={`/game/${id}`}>
						{tc("backToRound")}
					</Link>
					<Link
						className="text-green-200 hover:underline"
						href={`/game/${id}/historia`}
					>
						{tc("history")}
					</Link>
				</div>
				<h1 className="mt-2 text-3xl font-extrabold">
					{t("title", { season: data.seasonNo })}
				</h1>
				<p className="text-green-100">
					{t("champion", { champion: data.champion })}
				</p>
			</div>

			<section className="w-full max-w-3xl rounded-lg bg-white/10 p-4">
				<h2 className="mb-2 text-xl font-bold">{t("yourSeason")}</h2>
				<ul className="flex flex-col gap-1">
					<li>{t("position", { value: user.position })}</li>
					<li>{t("points", { value: user.points })}</li>
					<li>
						{t("record", {
							won: user.won,
							drawn: user.drawn,
							lost: user.lost,
						})}
					</li>
					<li>
						{t("goals", { for: user.goalsFor, against: user.goalsAgainst })}
					</li>
				</ul>
			</section>

			<section className="w-full max-w-3xl">
				<h2 className="mb-2 text-xl font-bold">{t("finalTable")}</h2>
				<table className="w-full text-left text-sm">
					<thead className="text-green-200">
						<tr>
							<th className="py-1 pr-2">{tc("table.position")}</th>
							<th className="py-1 pr-2">{tc("table.club")}</th>
							<th className="py-1 pr-2 text-right">{tc("table.played")}</th>
							<th className="py-1 pr-2 text-right">{tc("table.won")}</th>
							<th className="py-1 pr-2 text-right">{tc("table.drawn")}</th>
							<th className="py-1 pr-2 text-right">{tc("table.lost")}</th>
							<th className="py-1 pr-2 text-right">{tc("table.goals")}</th>
							<th className="py-1 pr-2 text-right">{tc("table.goalDiff")}</th>
							<th className="py-1 text-right">{tc("table.points")}</th>
						</tr>
					</thead>
					<tbody>
						{table.map((r) => (
							<tr
								className={
									r.clubId === userClubId
										? "bg-white/20 font-bold"
										: "border-t border-white/10"
								}
								key={r.clubId}
							>
								<td className="py-1 pr-2">{r.position}</td>
								<td className="py-1 pr-2">{r.name}</td>
								<td className="py-1 pr-2 text-right">{r.played}</td>
								<td className="py-1 pr-2 text-right">{r.won}</td>
								<td className="py-1 pr-2 text-right">{r.drawn}</td>
								<td className="py-1 pr-2 text-right">{r.lost}</td>
								<td className="py-1 pr-2 text-right">
									{r.goalsFor}:{r.goalsAgainst}
								</td>
								<td className="py-1 pr-2 text-right">{r.goalDiff}</td>
								<td className="py-1 text-right">{r.points}</td>
							</tr>
						))}
					</tbody>
				</table>
			</section>

			<section className="w-full max-w-3xl rounded-lg bg-white/10 p-4">
				<h2 className="mb-2 text-xl font-bold">{t("leagueStats")}</h2>
				<ul className="flex flex-col gap-1">
					<li>{t("matches", { value: format.number(stats.matches) })}</li>
					<li>{t("goalsPerMatch", { value: num(stats.goalsPerMatch, 2) })}</li>
					<li>{t("homeWins", { value: num(stats.homeWinPct, 1) })}</li>
					<li>{t("draws", { value: num(stats.drawPct, 1) })}</li>
					<li>{t("awayWins", { value: num(stats.awayWinPct, 1) })}</li>
				</ul>
			</section>
		</main>
	);
}
