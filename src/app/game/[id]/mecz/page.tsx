import Link from "next/link";
import { notFound } from "next/navigation";

import { MatchScreen } from "./_components/match-screen";

export const dynamic = "force-dynamic";

export default async function MatchPage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;
	if (!/^[1-9]\d*$/.test(id)) notFound();
	const gameId = Number(id);
	if (!Number.isSafeInteger(gameId)) notFound();

	return (
		<main className="flex min-h-screen flex-col items-center gap-4 bg-gradient-to-b from-[#0b3d1f] to-[#071a0e] px-4 py-8 text-white">
			<div className="w-full max-w-4xl">
				<Link className="text-green-200 hover:underline" href={`/game/${id}`}>
					← Kolejka
				</Link>
			</div>
			<MatchScreen gameId={gameId} />
		</main>
	);
}
