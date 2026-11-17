import queue from "../../../scripts/league-queue.json";

export type OpenLeague = {
	code: string;
	leagueApiId: number;
	name: string;
	country: string;
	timeZone: string;
};

const BASE: Omit<OpenLeague, "name">[] = [
	{
		code: "en.1",
		leagueApiId: 39,
		country: "England",
		timeZone: "Europe/London",
	},
	{
		code: "en.2",
		leagueApiId: 40,
		country: "England",
		timeZone: "Europe/London",
	},
	{
		code: "es.1",
		leagueApiId: 140,
		country: "Spain",
		timeZone: "Europe/Madrid",
	},
	{
		code: "de.1",
		leagueApiId: 78,
		country: "Germany",
		timeZone: "Europe/Berlin",
	},
	{
		code: "it.1",
		leagueApiId: 135,
		country: "Italy",
		timeZone: "Europe/Rome",
	},
	{
		code: "fr.1",
		leagueApiId: 61,
		country: "France",
		timeZone: "Europe/Paris",
	},
	{
		code: "nl.1",
		leagueApiId: 88,
		country: "Netherlands",
		timeZone: "Europe/Amsterdam",
	},
	{
		code: "pt.1",
		leagueApiId: 94,
		country: "Portugal",
		timeZone: "Europe/Lisbon",
	},
];

export const OPEN_SEASON = 2024;

export const OPEN_LEAGUES: OpenLeague[] = BASE.map((l) => {
	const q = queue.find((e) => e.league === l.leagueApiId);
	if (!q)
		throw new Error(`league ${l.leagueApiId} missing in league-queue.json`);
	return { ...l, name: q.name };
});
