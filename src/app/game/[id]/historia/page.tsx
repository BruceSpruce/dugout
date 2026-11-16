import { TRPCError } from "@trpc/server";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { api } from "~/trpc/server";

export const dynamic = "force-dynamic";

const MAX_INT = 2147483647;

export default async function HistoryPage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;
	if (!/^[1-9]\d*$/.test(id)) notFound();
	const gameId = Number(id);
	// Postgres integer range, as in the router's zod schema: larger ids are a 404, not a 500.
	if (gameId > MAX_INT) notFound();

	// The AI finished an abandoned match: the round screen shows the notice.
	const { settled } = await api.match.settle({ gameId });
	if (settled) redirect(`/game/${gameId}`);

	let data: Awaited<ReturnType<typeof api.game.history>>;
	try {
		data = await api.game.history({ gameId });
	} catch (e) {
		if (e instanceof TRPCError && e.code === "NOT_FOUND") notFound();
		throw e;
	}
	const { seasons, allTime, userClubId } = data;

	return (
		<main className="flex min-h-screen flex-col items-center gap-8 bg-gradient-to-b from-[#0b3d1f] to-[#071a0e] px-4 py-10 text-white">
			<div className="w-full max-w-3xl">
				<Link className="text-green-200 hover:underline" href={`/game/${id}`}>
					← Kolejka
				</Link>
				<h1 className="mt-2 text-3xl font-extrabold">Historia</h1>
			</div>

			{seasons.length === 0 ? (
				<p className="w-full max-w-3xl">Brak zakończonych sezonów.</p>
			) : (
				<>
					<section className="w-full max-w-3xl">
						<h2 className="mb-2 text-xl font-bold">Sezony</h2>
						<table className="w-full text-left text-sm">
							<thead className="text-green-200">
								<tr>
									<th className="py-1 pr-2">Sezon</th>
									<th className="py-1 pr-2">Mistrz</th>
									<th className="py-1 pr-2 text-right">Twoje miejsce</th>
									<th className="py-1 pr-2 text-right">Pkt</th>
									<th className="py-1 pr-2 text-right">W-R-P</th>
									<th className="py-1 text-right">Bramki</th>
								</tr>
							</thead>
							<tbody>
								{seasons.map((s) => (
									<tr className="border-t border-white/10" key={s.seasonNo}>
										<td className="py-1 pr-2">
											<Link
												className="text-green-200 hover:underline"
												href={`/game/${id}/sezon/${s.seasonNo}`}
											>
												Sezon {s.seasonNo}
											</Link>
										</td>
										<td className="py-1 pr-2">{s.champion}</td>
										<td className="py-1 pr-2 text-right">{s.position}</td>
										<td className="py-1 pr-2 text-right">{s.points}</td>
										<td className="py-1 pr-2 text-right">
											{s.won}-{s.drawn}-{s.lost}
										</td>
										<td className="py-1 text-right">
											{s.goalsFor}:{s.goalsAgainst}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</section>

					<section className="w-full max-w-3xl">
						<h2 className="mb-2 text-xl font-bold">Tabela wszech czasów</h2>
						<table className="w-full text-left text-sm">
							<thead className="text-green-200">
								<tr>
									<th className="py-1 pr-2">#</th>
									<th className="py-1 pr-2">Klub</th>
									<th className="py-1 pr-2 text-right">Sezony</th>
									<th className="py-1 pr-2 text-right">Tytuły</th>
									<th className="py-1 pr-2 text-right">M</th>
									<th className="py-1 pr-2 text-right">W</th>
									<th className="py-1 pr-2 text-right">R</th>
									<th className="py-1 pr-2 text-right">P</th>
									<th className="py-1 pr-2 text-right">Bramki</th>
									<th className="py-1 text-right">Pkt</th>
								</tr>
							</thead>
							<tbody>
								{allTime.map((r, i) => (
									<tr
										className={
											r.clubId === userClubId
												? "bg-white/20 font-bold"
												: "border-t border-white/10"
										}
										key={r.clubId}
									>
										<td className="py-1 pr-2">{i + 1}</td>
										<td className="py-1 pr-2">{r.name}</td>
										<td className="py-1 pr-2 text-right">{r.seasons}</td>
										<td className="py-1 pr-2 text-right">{r.titles}</td>
										<td className="py-1 pr-2 text-right">{r.played}</td>
										<td className="py-1 pr-2 text-right">{r.won}</td>
										<td className="py-1 pr-2 text-right">{r.drawn}</td>
										<td className="py-1 pr-2 text-right">{r.lost}</td>
										<td className="py-1 pr-2 text-right">
											{r.goalsFor}:{r.goalsAgainst}
										</td>
										<td className="py-1 text-right">{r.points}</td>
									</tr>
								))}
							</tbody>
						</table>
					</section>
				</>
			)}
		</main>
	);
}
