// Player attribute model: per-90 metrics shrunk toward a position prior, scaled to 0-100 by percentile.
// Pure module: no imports outside src/engine/ (runs from the CLI for calibration).

export type Position = "Goalkeeper" | "Defender" | "Midfielder" | "Attacker";

export type Counters = {
	goals: number;
	penaltyScored: number;
	shotsTotal: number;
	shotsOn: number;
	assists: number;
	passesKey: number;
	passesTotal: number;
	dribblesSuccess: number;
	tackles: number;
	interceptions: number;
	blocks: number;
	duels: number;
	duelsWon: number;
	dribblesPast: number;
	saves: number;
	goalsConceded: number;
	penaltySaved: number;
	foulsCommitted: number;
	yellowCards: number;
	yellowRedCards: number;
	redCards: number;
};

export type PlayerInput = {
	playerId: number;
	name: string;
	clubId: number;
	position: Position;
	minutes: number;
	/** Minute-weighted average match rating, null when there is none. */
	ratingMinutes: number | null;
	/** Club matches x 90. */
	clubPlayedMinutes: number;
	counters: Counters;
};

export type PlayerAttributes = {
	playerId: number;
	name: string;
	clubId: number;
	position: Position;
	minutes: number;
	attack: number;
	creativity: number;
	defense: number;
	goalkeeping: number;
	discipline: number;
	overall: number;
};

export type AttributeName =
	| "attack"
	| "creativity"
	| "defense"
	| "goalkeeping"
	| "discipline";

type MetricId =
	| "goalsNp"
	| "shotsOn"
	| "shots"
	| "passesKey"
	| "assists"
	| "dribbles"
	| "passes"
	| "defActions"
	| "duelPct"
	| "dribblesPast"
	| "saves"
	| "conceded"
	| "penaltySaved"
	| "discipline";

type MetricSpec = { weight: number; lowerIsBetter?: boolean };
type OverallWeights = Partial<
	Record<AttributeName | "rating" | "minutesShare", number>
>;

export type AttributeModel = {
	/** Minutes of pseudo-observations at the prior (shrinkage strength). */
	minutesK: number;
	/** Same for the duel win % metric, counted in duels. */
	duelsK: number;
	/** Prior percentile for more-is-better metrics. */
	priorPercentile: number;
	/** Prior percentile for less-is-better metrics. */
	worsePriorPercentile: number;
	/** Minutes needed to enter the reference distribution. */
	minReferenceMinutes: number;
	/** Smaller position groups fall back to the league-wide distribution. */
	minGroupSize: number;
	metrics: Record<AttributeName, Partial<Record<MetricId, MetricSpec>>>;
	overall: Record<Position, OverallWeights>;
};

export const ATTRIBUTE_MODEL: AttributeModel = {
	minutesK: 900,
	duelsK: 50,
	priorPercentile: 25,
	worsePriorPercentile: 75,
	minReferenceMinutes: 450,
	minGroupSize: 5,
	metrics: {
		attack: {
			goalsNp: { weight: 0.5 },
			shotsOn: { weight: 0.3 },
			shots: { weight: 0.2 },
		},
		creativity: {
			passesKey: { weight: 0.35 },
			assists: { weight: 0.25 },
			dribbles: { weight: 0.2 },
			passes: { weight: 0.2 },
		},
		defense: {
			defActions: { weight: 0.4 },
			duelPct: { weight: 0.4 },
			dribblesPast: { weight: 0.2, lowerIsBetter: true },
		},
		goalkeeping: {
			saves: { weight: 0.4 },
			conceded: { weight: 0.5, lowerIsBetter: true },
			penaltySaved: { weight: 0.1 },
		},
		discipline: { discipline: { weight: 1, lowerIsBetter: true } },
	},
	overall: {
		Goalkeeper: { goalkeeping: 0.6, rating: 0.2, minutesShare: 0.2 },
		Defender: {
			defense: 0.45,
			creativity: 0.1,
			discipline: 0.05,
			rating: 0.2,
			minutesShare: 0.2,
		},
		Midfielder: {
			creativity: 0.35,
			defense: 0.15,
			attack: 0.1,
			rating: 0.2,
			minutesShare: 0.2,
		},
		Attacker: {
			attack: 0.45,
			creativity: 0.15,
			rating: 0.2,
			minutesShare: 0.2,
		},
	},
};

// raw = metric value (null: no data -> prior), n = observation weight used for shrinkage
type Obs = { raw: number | null; n: number };

const per90 = (p: PlayerInput, x: number): Obs => ({
	raw: p.minutes > 0 ? (x * 90) / p.minutes : 0,
	n: p.minutes,
});

const METRICS: Record<MetricId, (p: PlayerInput) => Obs> = {
	goalsNp: (p) => per90(p, p.counters.goals - p.counters.penaltyScored),
	shotsOn: (p) => per90(p, p.counters.shotsOn),
	shots: (p) => per90(p, p.counters.shotsTotal),
	passesKey: (p) => per90(p, p.counters.passesKey),
	assists: (p) => per90(p, p.counters.assists),
	dribbles: (p) => per90(p, p.counters.dribblesSuccess),
	passes: (p) => per90(p, p.counters.passesTotal),
	defActions: (p) =>
		per90(p, p.counters.tackles + p.counters.interceptions + p.counters.blocks),
	duelPct: (p) => ({
		raw: p.counters.duels > 0 ? p.counters.duelsWon / p.counters.duels : null,
		n: p.counters.duels,
	}),
	dribblesPast: (p) => per90(p, p.counters.dribblesPast),
	saves: (p) => per90(p, p.counters.saves),
	conceded: (p) => per90(p, p.counters.goalsConceded),
	penaltySaved: (p) => per90(p, p.counters.penaltySaved),
	discipline: (p) =>
		per90(
			p,
			p.counters.foulsCommitted +
				3 * p.counters.yellowCards +
				6 * (p.counters.yellowRedCards + p.counters.redCards),
		),
};

const RATING: (p: PlayerInput) => Obs = (p) => ({
	raw: p.ratingMinutes,
	n: p.ratingMinutes === null ? 0 : p.minutes,
});

const minutesShare = (p: PlayerInput) =>
	p.clubPlayedMinutes > 0 ? Math.min(1, p.minutes / p.clubPlayedMinutes) : 0;

/** Linear-interpolated quantile of an ascending array, q in 0-100. */
function quantile(sorted: number[], q: number): number {
	if (sorted.length === 0) return 0;
	const pos = ((sorted.length - 1) * q) / 100;
	const lo = Math.floor(pos);
	const hi = Math.ceil(pos);
	const a = sorted[lo] ?? 0;
	const b = sorted[hi] ?? a;
	return a + (b - a) * (pos - lo);
}

/** Inverse of quantile(): percentile 0-100 of v within an ascending array (ties get the mean position). */
function percentileRank(sorted: number[], v: number): number {
	const n = sorted.length;
	if (n === 0) return 50;
	if (n === 1) return 50;
	const first = sorted.findIndex((x) => x >= v);
	if (first === -1) return 100;
	if ((sorted[first] ?? 0) === v) {
		let last = first;
		while ((sorted[last + 1] ?? Number.NaN) === v) last++;
		return (((first + last) / 2) * 100) / (n - 1);
	}
	if (first === 0) return 0;
	const a = sorted[first - 1] ?? 0;
	const b = sorted[first] ?? a;
	return ((first - 1 + (v - a) / (b - a)) * 100) / (n - 1);
}

const shrink = (o: Obs, prior: number, k: number) =>
	((o.raw ?? prior) * o.n + k * prior) / (o.n + k);

const asc = (a: number, b: number) => a - b;

/** Prior and ascending reference distribution of shrunk values for one metric. */
type Scale = { prior: number; sorted: number[]; k: number };

function buildScale(
	ref: PlayerInput[],
	obs: (p: PlayerInput) => Obs,
	k: number,
	priorPct: number,
): Scale {
	const observed = ref
		.map(obs)
		.filter((o) => o.raw !== null)
		.map((o) => o.raw as number)
		.sort(asc);
	const prior = quantile(observed, priorPct);
	const sorted = ref.map((p) => shrink(obs(p), prior, k)).sort(asc);
	return { prior, sorted, k };
}

const score = (s: Scale, o: Obs, lowerIsBetter: boolean) => {
	const pct = percentileRank(s.sorted, shrink(o, s.prior, s.k));
	return lowerIsBetter ? 100 - pct : pct;
};

const clamp = (x: number) => Math.max(0, Math.min(100, Math.round(x)));

type Context = {
	metrics: Map<MetricId, Scale>;
	rating: Scale;
	share: number[];
};

export function computeAttributes(
	players: PlayerInput[],
	model: AttributeModel = ATTRIBUTE_MODEL,
): PlayerAttributes[] {
	const refAll = players.filter((p) => p.minutes >= model.minReferenceMinutes);
	const leagueRef = refAll.length > 0 ? refAll : players;
	const contexts = new Map<Position, Context>();

	const contextFor = (position: Position): Context => {
		const cached = contexts.get(position);
		if (cached) return cached;
		const group = refAll.filter((p) => p.position === position);
		const ref = group.length >= model.minGroupSize ? group : leagueRef;
		const metrics = new Map<MetricId, Scale>();
		for (const specs of Object.values(model.metrics)) {
			for (const [id, spec] of Object.entries(specs) as [
				MetricId,
				MetricSpec,
			][]) {
				if (metrics.has(id)) continue;
				metrics.set(
					id,
					buildScale(
						ref,
						METRICS[id],
						id === "duelPct" ? model.duelsK : model.minutesK,
						spec.lowerIsBetter
							? model.worsePriorPercentile
							: model.priorPercentile,
					),
				);
			}
		}
		const ctx: Context = {
			metrics,
			rating: buildScale(ref, RATING, model.minutesK, model.priorPercentile),
			share: ref.map(minutesShare).sort(asc),
		};
		contexts.set(position, ctx);
		return ctx;
	};

	return players.map((p) => {
		const ctx = contextFor(p.position);
		const attr = {} as Record<AttributeName, number>;
		for (const [name, specs] of Object.entries(model.metrics) as [
			AttributeName,
			Partial<Record<MetricId, MetricSpec>>,
		][]) {
			let sum = 0;
			let weights = 0;
			for (const [id, spec] of Object.entries(specs) as [
				MetricId,
				MetricSpec,
			][]) {
				const scale = ctx.metrics.get(id);
				if (!scale) continue;
				sum += spec.weight * score(scale, METRICS[id](p), !!spec.lowerIsBetter);
				weights += spec.weight;
			}
			attr[name] = weights > 0 ? sum / weights : 0;
		}
		const signals = {
			...attr,
			rating: score(ctx.rating, RATING(p), false),
			minutesShare: percentileRank(ctx.share, minutesShare(p)),
		};
		let sum = 0;
		let weights = 0;
		for (const [key, w] of Object.entries(model.overall[p.position])) {
			sum += w * signals[key as keyof typeof signals];
			weights += w;
		}
		return {
			playerId: p.playerId,
			name: p.name,
			clubId: p.clubId,
			position: p.position,
			minutes: p.minutes,
			attack: clamp(attr.attack),
			creativity: clamp(attr.creativity),
			defense: clamp(attr.defense),
			goalkeeping: clamp(attr.goalkeeping),
			discipline: clamp(attr.discipline),
			overall: clamp(weights > 0 ? sum / weights : 0),
		};
	});
}
