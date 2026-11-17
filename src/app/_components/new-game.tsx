"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { errorText } from "~/i18n/error-text";
import { api } from "~/trpc/react";

const COUNTRY_KEYS = new Set([
	"England",
	"Spain",
	"Germany",
	"Italy",
	"France",
	"Netherlands",
	"Portugal",
]);
type CountryKey =
	| "England"
	| "Spain"
	| "Germany"
	| "Italy"
	| "France"
	| "Netherlands"
	| "Portugal";

type LeagueItem = {
	competitionSeasonId: number;
	name: string;
	country: string | null;
	season: number;
	clubCount: number;
	playable: boolean;
};

export function NewGame({ leagues }: { leagues: LeagueItem[] }) {
	const t = useTranslations();
	const [leagueId, setLeagueId] = useState<number | null>(null);
	const league = leagues.find((l) => l.competitionSeasonId === leagueId);

	return (
		<section className="w-full max-w-4xl">
			<h2 className="mb-4 text-2xl font-bold">{t("home.newGame")}</h2>
			{league ? (
				<ClubPicker league={league} onBack={() => setLeagueId(null)} />
			) : (
				<>
					<h3 className="mb-3 text-lg font-semibold">
						{t("home.chooseLeague")}
					</h3>
					<ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
						{leagues.map((l) => (
							<li key={l.competitionSeasonId}>
								<button
									className="flex w-full flex-col items-center gap-1 rounded-lg bg-white/10 p-3 text-center hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-white/10"
									disabled={!l.playable}
									onClick={() => setLeagueId(l.competitionSeasonId)}
									type="button"
								>
									<span className="text-sm font-semibold">{l.name}</span>
									<span className="text-xs text-white/70">
										{t("home.leagueInfo", {
											country:
												l.country && COUNTRY_KEYS.has(l.country)
													? t(`countries.${l.country as CountryKey}`)
													: (l.country ?? ""),
											clubs: l.clubCount,
										})}
									</span>
									{l.playable ? null : (
										<span className="text-xs text-white/60 italic">
											{t("home.squadsSoon")}
										</span>
									)}
								</button>
							</li>
						))}
					</ul>
				</>
			)}
		</section>
	);
}

function ClubPicker({
	league,
	onBack,
}: {
	league: LeagueItem;
	onBack: () => void;
}) {
	const router = useRouter();
	const t = useTranslations();
	const clubs = api.game.clubs.useQuery({
		competitionSeasonId: league.competitionSeasonId,
	});
	const create = api.game.create.useMutation({
		onSuccess: ({ gameId }) => router.push(`/game/${gameId}`),
	});

	return (
		<>
			<div className="mb-3 flex items-center justify-between gap-3">
				<h3 className="text-lg font-semibold">
					{league.name} — {t("home.chooseClub")}
				</h3>
				<button
					className="rounded-lg bg-white/10 px-3 py-1 text-sm hover:bg-white/20 disabled:opacity-50"
					disabled={create.isPending || create.isSuccess}
					onClick={onBack}
					type="button"
				>
					{t("home.changeLeague")}
				</button>
			</div>
			{clubs.isPending ? <p>{t("home.loadingClubs")}</p> : null}
			{clubs.error ? (
				<p className="text-red-300">{errorText(t, clubs.error)}</p>
			) : null}
			<ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
				{(clubs.data ?? []).map((c) => (
					<li key={c.clubId}>
						<button
							className="flex w-full flex-col items-center gap-2 rounded-lg bg-white/10 p-3 text-center hover:bg-white/20 disabled:opacity-50"
							disabled={create.isPending || create.isSuccess}
							onClick={() =>
								create.mutate({
									competitionSeasonId: league.competitionSeasonId,
									clubId: c.clubId,
								})
							}
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
		</>
	);
}
