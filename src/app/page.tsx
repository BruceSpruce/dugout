import { TRPCError } from "@trpc/server";
import Link from "next/link";

import { NewGame } from "~/app/_components/new-game";
import { api } from "~/trpc/server";

export const dynamic = "force-dynamic";

export default async function Home() {
	let clubs: Awaited<ReturnType<typeof api.game.clubs>> | null = null;
	let notLoaded: string | null = null;
	try {
		clubs = await api.game.clubs();
	} catch (e) {
		if (e instanceof TRPCError && e.code === "NOT_FOUND") {
			notLoaded = e.message;
		} else {
			throw e;
		}
	}
	const games = await api.game.list();

	return (
		<main className="flex min-h-screen flex-col items-center gap-10 bg-gradient-to-b from-[#0b3d1f] to-[#071a0e] px-4 py-12 text-white">
			<h1 className="text-5xl font-extrabold tracking-tight sm:text-[5rem]">
				Dugout
			</h1>
			{games.length > 0 ? (
				<section className="w-full max-w-4xl">
					<h2 className="mb-4 text-2xl font-bold">Twoje gry</h2>
					<ul className="flex flex-col gap-2">
						{games.map((g) => (
							<li key={g.gameId}>
								<Link
									className="block rounded-lg bg-white/10 p-3 hover:bg-white/20"
									href={`/game/${g.gameId}`}
								>
									{g.clubName} — sezon {g.seasonNo}, kolejka {g.currentRound}
								</Link>
							</li>
						))}
					</ul>
				</section>
			) : null}
			{clubs ? <NewGame clubs={clubs} /> : null}
			{notLoaded ? <p className="text-red-300">{notLoaded}</p> : null}
		</main>
	);
}
