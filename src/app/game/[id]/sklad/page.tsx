import { TRPCError } from "@trpc/server";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { api } from "~/trpc/server";
import { LineupEditor } from "./_components/lineup-editor";

export const dynamic = "force-dynamic";

export default async function LineupPage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;
	if (!/^[1-9]\d*$/.test(id)) notFound();
	const gameId = Number(id);
	if (!Number.isSafeInteger(gameId)) notFound();

	// The AI finished an abandoned match: the round screen shows the notice.
	const { settled } = await api.match.settle({ gameId });
	if (settled) redirect(`/game/${gameId}`);

	let data: Awaited<ReturnType<typeof api.game.lineup>>;
	try {
		data = await api.game.lineup({ gameId });
	} catch (e) {
		if (e instanceof TRPCError && e.code === "NOT_FOUND") notFound();
		throw e;
	}

	return (
		<main className="flex min-h-screen flex-col items-center gap-6 bg-gradient-to-b from-[#0b3d1f] to-[#071a0e] px-4 py-10 text-white">
			<div className="w-full max-w-4xl">
				<Link className="text-green-200 hover:underline" href={`/game/${id}`}>
					← Kolejka
				</Link>
				<h1 className="mt-2 text-3xl font-extrabold">Skład</h1>
			</div>
			<LineupEditor
				gameId={gameId}
				proposal={data.proposal}
				saved={data.saved}
				squad={data.squad}
			/>
		</main>
	);
}
