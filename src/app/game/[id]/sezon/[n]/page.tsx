import { TRPCError } from "@trpc/server";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { api } from "~/trpc/server";

export const dynamic = "force-dynamic";

const MAX_INT = 2147483647;

/** Polish decimal format (comma), fixed digits. */
const num = (v: number, digits: number) =>
	v.toLocaleString("pl-PL", {
		minimumFractionDigits: digits,
		maximumFractionDigits: digits,
	});

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

	return (
		<main className="flex min-h-screen flex-col items-center gap-8 bg-gradient-to-b from-[#0b3d1f] to-[#071a0e] px-4 py-10 text-white">
			<div className="w-full max-w-3xl">
				<div className="flex items-center justify-between gap-4">
					<Link className="text-green-200 hover:underline" href={`/game/${id}`}>
						← Kolejka
					</Link>
					<Link
						className="text-green-200 hover:underline"
						href={`/game/${id}/historia`}
					>
						Historia
					</Link>
				</div>
				<h1 className="mt-2 text-3xl font-extrabold">
					Sezon {data.seasonNo} — podsumowanie
				</h1>
				<p className="text-green-100">Mistrz: {data.champion}</p>
			</div>

			<section className="w-full max-w-3xl rounded-lg bg-white/10 p-4">
				<h2 className="mb-2 text-xl font-bold">Twój sezon</h2>
				<ul className="flex flex-col gap-1">
					<li>Miejsce: {user.position}</li>
					<li>Punkty: {user.points}</li>
					<li>
						Bilans (W-R-P): {user.won}-{user.drawn}-{user.lost}
					</li>
					<li>
						Bramki: {user.goalsFor}:{user.goalsAgainst}
					</li>
				</ul>
			</section>

			<section className="w-full max-w-3xl">
				<h2 className="mb-2 text-xl font-bold">Tabela końcowa</h2>
				<table className="w-full text-left text-sm">
					<thead className="text-green-200">
						<tr>
							<th className="py-1 pr-2">#</th>
							<th className="py-1 pr-2">Klub</th>
							<th className="py-1 pr-2 text-right">M</th>
							<th className="py-1 pr-2 text-right">W</th>
							<th className="py-1 pr-2 text-right">R</th>
							<th className="py-1 pr-2 text-right">P</th>
							<th className="py-1 pr-2 text-right">Bramki</th>
							<th className="py-1 pr-2 text-right">+/−</th>
							<th className="py-1 text-right">Pkt</th>
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
				<h2 className="mb-2 text-xl font-bold">Statystyki ligi</h2>
				<ul className="flex flex-col gap-1">
					<li>Mecze: {stats.matches}</li>
					<li>Gole na mecz: {num(stats.goalsPerMatch, 2)}</li>
					<li>Wygrane gospodarzy: {num(stats.homeWinPct, 1)}%</li>
					<li>Remisy: {num(stats.drawPct, 1)}%</li>
					<li>Wygrane gości: {num(stats.awayWinPct, 1)}%</li>
				</ul>
			</section>
		</main>
	);
}
