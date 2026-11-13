import { TRPCError } from "@trpc/server";
import Link from "next/link";
import { notFound } from "next/navigation";

import { api } from "~/trpc/server";

export const dynamic = "force-dynamic";

const formatDate = (d: Date) =>
	d.toLocaleString("pl-PL", {
		timeZone: "Europe/Warsaw",
		dateStyle: "medium",
		timeStyle: "short",
	});

export default async function GamePage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;
	if (!/^[1-9]\d*$/.test(id)) notFound();
	const gameId = Number(id);
	if (!Number.isSafeInteger(gameId)) notFound();

	let screen: Awaited<ReturnType<typeof api.game.roundScreen>>;
	try {
		screen = await api.game.roundScreen({ gameId });
	} catch (e) {
		if (e instanceof TRPCError && e.code === "NOT_FOUND") notFound();
		throw e;
	}
	const { nextMatch, table, previousRound } = screen;

	return (
		<main className="flex min-h-screen flex-col items-center gap-8 bg-gradient-to-b from-[#0b3d1f] to-[#071a0e] px-4 py-10 text-white">
			<div className="w-full max-w-3xl">
				<Link className="text-green-200 hover:underline" href="/">
					← Gry
				</Link>
				<h1 className="mt-2 text-3xl font-extrabold">{screen.clubName}</h1>
				<p className="text-green-100">
					Kolejka {screen.round} / {screen.totalRounds}
				</p>
			</div>

			<section className="w-full max-w-3xl rounded-lg bg-white/10 p-4">
				<h2 className="mb-2 text-xl font-bold">Najbliższy mecz</h2>
				{nextMatch ? (
					<p>
						{nextMatch.opponent} ({nextMatch.home ? "u siebie" : "na wyjeździe"}
						) — {formatDate(nextMatch.kickoffAt)}, kolejka {nextMatch.round}
					</p>
				) : (
					<p>Sezon zakończony</p>
				)}
			</section>

			<section className="w-full max-w-3xl">
				<h2 className="mb-2 text-xl font-bold">Tabela</h2>
				<table className="w-full text-left text-sm">
					<thead className="text-green-200">
						<tr>
							<th className="py-1 pr-2">#</th>
							<th className="py-1 pr-2">Klub</th>
							<th className="py-1 pr-2 text-right">M</th>
							<th className="py-1 pr-2 text-right">Pkt</th>
							<th className="py-1 pr-2 text-right">+/−</th>
							<th className="py-1 text-right">Bramki</th>
						</tr>
					</thead>
					<tbody>
						{table.map((r) => (
							<tr
								className={
									r.name === screen.clubName
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
				<h2 className="mb-2 text-xl font-bold">Poprzednia kolejka</h2>
				{previousRound ? (
					<ul className="flex flex-col gap-1">
						{previousRound.matches.map((m) => (
							<li key={`${m.home}-${m.away}`}>
								{m.home} {m.homeGoals}:{m.awayGoals} {m.away}
							</li>
						))}
					</ul>
				) : (
					<p>Brak — to pierwsza kolejka</p>
				)}
			</section>
		</main>
	);
}
