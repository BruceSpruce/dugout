"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { errorText } from "~/i18n/error-text";
import { api } from "~/trpc/react";

type ClubItem = { clubId: number; name: string; logoUrl: string | null };

export function NewGame({ clubs }: { clubs: ClubItem[] }) {
	const router = useRouter();
	const t = useTranslations();
	const create = api.game.create.useMutation({
		onSuccess: ({ gameId }) => router.push(`/game/${gameId}`),
	});

	return (
		<section className="w-full max-w-4xl">
			<h2 className="mb-4 text-2xl font-bold">{t("home.newGame")}</h2>
			<ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
				{clubs.map((c) => (
					<li key={c.clubId}>
						<button
							className="flex w-full flex-col items-center gap-2 rounded-lg bg-white/10 p-3 text-center hover:bg-white/20 disabled:opacity-50"
							disabled={create.isPending || create.isSuccess}
							onClick={() => create.mutate({ clubId: c.clubId })}
							type="button"
						>
							{c.logoUrl ? (
								// biome-ignore lint/performance/noImgElement: external logo URLs, no remote image config
								<img alt={c.name} className="h-12 w-12" src={c.logoUrl} />
							) : null}
							<span className="text-sm font-semibold">{c.name}</span>
						</button>
					</li>
				))}
			</ul>
			{create.error ? (
				<p className="mt-4 text-red-300">{errorText(t, create.error)}</p>
			) : null}
		</section>
	);
}
