import { describe, expect, it } from "vitest";
import type { PlayerAttributes } from "./attributes";
import {
	applyLiveOutcome,
	beforeRound,
	effectiveOverall,
	eventProbabilities,
	freshState,
	isAvailable,
	matchEvents,
	STATE_MODEL,
	updateForm,
} from "./player-state";
import { createRng, type Rng } from "./rng";

const player = (discipline: number, overall = 60): PlayerAttributes => ({
	playerId: 1,
	name: "P",
	clubId: 1,
	position: "Midfielder",
	minutes: 2000,
	attack: 50,
	creativity: 50,
	defense: 50,
	goalkeeping: 0,
	discipline,
	overall,
});

/** Rng returning the given values in order for the 6 draws of one match. */
const scripted = (values: number[]): Rng => {
	let i = 0;
	return () => values[i++] ?? 0.99;
};

// [yellow, second yellow, straight red, injury, duration bucket, duration uniform]
const YELLOW = [0, 0.99, 0.99, 0.99, 0, 0];
const SECOND_YELLOW = [0, 0, 0.99, 0.99, 0, 0];
const STRAIGHT = [0.99, 0.99, 0, 0.99, 0, 0];

describe("pauzy za kartki (PL)", () => {
	const yellowAt = (count: number, round: number) =>
		matchEvents(
			player(50),
			{ ...freshState(), yellowCount: count },
			round,
			scripted(YELLOW),
		);

	it("5. zolta w kolejce 19 daje 1 mecz, w kolejce 20 nic", () => {
		expect(yellowAt(4, 19).banned).toBe(1);
		expect(yellowAt(4, 19).state.suspendedFor).toBe(1);
		expect(yellowAt(4, 20).banned).toBe(0);
	});

	it("10. zolta w kolejce 32 daje 2 mecze, w 33 nic", () => {
		expect(yellowAt(9, 32).banned).toBe(2);
		expect(yellowAt(9, 33).banned).toBe(0);
	});

	it("15. zolta daje 3 mecze o kazdej porze", () => {
		expect(yellowAt(14, 38).banned).toBe(3);
	});

	it("czerwona bezposrednia daje 3 mecze", () => {
		const r = matchEvents(player(50), freshState(), 10, scripted(STRAIGHT));
		expect(r.red).toBe("straight");
		expect(r.banned).toBe(3);
		expect(r.yellow).toBe(false);
		expect(r.state.suspendedFor).toBe(3);
	});

	it("druga zolta daje 1 mecz i nie zwieksza yellowCount", () => {
		const r = matchEvents(
			player(50),
			{ ...freshState(), yellowCount: 4 },
			10,
			scripted(SECOND_YELLOW),
		);
		expect(r.yellow).toBe(true);
		expect(r.red).toBe("second-yellow");
		expect(r.banned).toBe(1);
		expect(r.state.yellowCount).toBe(4);
	});

	it("pauzy sie sumuja", () => {
		const r = matchEvents(
			player(50),
			{ ...freshState(), yellowCount: 4, suspendedFor: 2 },
			10,
			scripted([0, 0.99, 0, 0.99, 0, 0]),
		);
		expect(r.red).toBe("straight");
		expect(r.banned).toBe(4);
		expect(r.state.suspendedFor).toBe(6);
	});
});

describe("czestosc zoltych", () => {
	const N = 200_000;
	const yellowRate = (discipline: number, seed: number) => {
		const rng = createRng(seed);
		const p = player(discipline);
		let n = 0;
		for (let i = 0; i < N; i++) {
			if (matchEvents(p, freshState(), 10, rng).yellow) n++;
		}
		return n / N;
	};

	const rates: number[] = [];
	for (const [discipline, seed] of [
		[20, 11],
		[50, 12],
		[80, 13],
	] as const) {
		it(`zgodna z formula dla discipline ${discipline} (3 sigma)`, () => {
			const p =
				STATE_MODEL.yellowBase *
				Math.exp((STATE_MODEL.disciplineSlope * (50 - discipline)) / 50);
			const sigma = Math.sqrt((p * (1 - p)) / N);
			const rate = yellowRate(discipline, seed);
			rates.push(rate);
			expect(Math.abs(rate - p)).toBeLessThan(3 * sigma);
		});
	}

	it("rosnie, gdy discipline maleje", () => {
		const [low, mid, high] = [20, 50, 80].map((d) => yellowRate(d, 5));
		expect(low).toBeGreaterThan(mid ?? 0);
		expect(mid).toBeGreaterThan(high ?? 0);
	});
});

describe("kontuzje", () => {
	it("dlugosci w przedzialach i z wagami (3 sigma)", () => {
		const N = 200_000;
		const rng = createRng(21);
		const p = player(50);
		const counts = STATE_MODEL.injuryDurations.map(() => 0);
		let injuries = 0;
		let outOfRange = 0;
		for (let i = 0; i < N; i++) {
			const { injured } = matchEvents(p, freshState(), 10, rng);
			if (injured === 0) continue;
			injuries++;
			const idx = STATE_MODEL.injuryDurations.findIndex(
				(d) => injured >= d.matches[0] && injured <= d.matches[1],
			);
			if (idx < 0) outOfRange++;
			else counts[idx] = (counts[idx] ?? 0) + 1;
		}
		expect(outOfRange).toBe(0);
		const rateSigma = Math.sqrt(
			(STATE_MODEL.injuryRate * (1 - STATE_MODEL.injuryRate)) / N,
		);
		expect(Math.abs(injuries / N - STATE_MODEL.injuryRate)).toBeLessThan(
			3 * rateSigma,
		);
		const totalWeight = STATE_MODEL.injuryDurations.reduce(
			(s, d) => s + d.weight,
			0,
		);
		STATE_MODEL.injuryDurations.forEach((d, i) => {
			const w = d.weight / totalWeight;
			const sigma = Math.sqrt((w * (1 - w)) / injuries);
			expect(Math.abs((counts[i] ?? 0) / injuries - w)).toBeLessThan(3 * sigma);
		});
	});

	it("nowa kontuzja nie skraca trwajacej", () => {
		const r = matchEvents(
			player(50),
			{ ...freshState(), injuredFor: 30 },
			10,
			scripted([0.99, 0.99, 0.99, 0, 0, 0]),
		);
		expect(r.injured).toBe(1);
		expect(r.state.injuredFor).toBe(30);
	});
});

describe("beforeRound", () => {
	it("regeneruje kondycje do max 100", () => {
		const low = beforeRound({ ...freshState(), fitness: 50 }, true);
		expect(low.state.fitness).toBe(50 + STATE_MODEL.fitnessRecovery);
		const high = beforeRound({ ...freshState(), fitness: 97 }, false);
		expect(high.state.fitness).toBe(100);
	});

	it("odlicza pauze i kontuzje tylko gdy klub gra", () => {
		const s = { ...freshState(), suspendedFor: 2, injuredFor: 1 };
		const idle = beforeRound(s, false);
		expect(idle.state.suspendedFor).toBe(2);
		expect(idle.state.injuredFor).toBe(1);
		const played = beforeRound(s, true);
		expect(played.state.suspendedFor).toBe(1);
		expect(played.state.injuredFor).toBe(0);
	});

	it("pauza 1 meczu: niedostepny dokladnie w najblizszej kolejce klubu", () => {
		const banned = { ...freshState(), suspendedFor: 1 };
		const next = beforeRound(banned, true);
		expect(next.available).toBe(false);
		const after = beforeRound(next.state, true);
		expect(after.available).toBe(true);
		expect(isAvailable(after.state)).toBe(true);
	});

	it("nie schodzi ponizej zera", () => {
		const r = beforeRound(freshState(), true);
		expect(r.state.suspendedFor).toBe(0);
		expect(r.state.injuredFor).toBe(0);
	});
});

describe("effectiveOverall", () => {
	it("swiezy neutralny zawodnik = overall", () => {
		expect(effectiveOverall(player(50, 70), freshState())).toBeCloseTo(70, 10);
	});

	it("nizsza kondycja i ujemna forma daja mniej", () => {
		const base = effectiveOverall(player(50, 70), freshState());
		expect(
			effectiveOverall(player(50, 70), { ...freshState(), fitness: 40 }),
		).toBeLessThan(base);
		expect(
			effectiveOverall(player(50, 70), { ...freshState(), form: -1 }),
		).toBeLessThan(base);
		expect(
			effectiveOverall(player(50, 70), { ...freshState(), form: 1 }),
		).toBeGreaterThan(base);
	});
});

describe("updateForm", () => {
	it("zbiega do +1 po serii wygranych i do -1 po porazkach", () => {
		let s = freshState();
		for (let i = 0; i < 60; i++) s = updateForm(s, "win");
		expect(s.form).toBeGreaterThan(0.99);
		expect(s.form).toBeLessThanOrEqual(1);
		for (let i = 0; i < 60; i++) s = updateForm(s, "loss");
		expect(s.form).toBeLessThan(-0.99);
	});

	it("remis przyciaga do zera", () => {
		const s = updateForm({ ...freshState(), form: 0.8 }, "draw");
		expect(s.form).toBeCloseTo(0.56, 10);
	});
});

describe("determinizm", () => {
	it("ten sam seed daje te same zdarzenia, a rng zuzywa 6 losowan", () => {
		const run = (seed: number) => {
			const rng = createRng(seed);
			const out = [];
			let s = freshState();
			for (let r = 1; r <= 200; r++) {
				const e = matchEvents(player(30), s, r, rng);
				out.push(e);
				s = e.state;
			}
			return out;
		};
		expect(run(7)).toEqual(run(7));
		expect(run(7)).not.toEqual(run(8));

		const NONE = [0.99, 0.99, 0.99, 0.99, 0, 0];
		const INJURY = [0.99, 0.99, 0.99, 0, 0, 0];
		const scenarios: [string, number[] | undefined][] = [
			["brak zdarzen", NONE],
			["zolta", YELLOW],
			["druga zolta", SECOND_YELLOW],
			["czerwona wprost", STRAIGHT],
			["kontuzja", INJURY],
			["rng stale 0.5", undefined],
		];
		for (const [label, values] of scenarios) {
			let calls = 0;
			const inner = values ? scripted(values) : () => 0.5;
			const counting: Rng = () => {
				calls++;
				return inner();
			};
			const e = matchEvents(player(50), freshState(), 1, counting);
			expect(calls, label).toBe(6);
			if (label === "kontuzja") expect(e.injured).toBeGreaterThan(0);
			if (label === "czerwona wprost") expect(e.red).toBe("straight");
		}
	});
});

describe("wspolne reguly zdarzen (mecz na zywo)", () => {
	it("matchEvents bit w bit jak przed wydzieleniem regul (staly seed)", () => {
		const rng = createRng(2026);
		let s = freshState();
		const out: unknown[] = [];
		for (let r = 1; r <= 400; r++) {
			const e = matchEvents(player(10 + (r % 80)), s, (r % 38) + 1, rng);
			out.push(e);
			s = e.state;
		}
		const str = JSON.stringify(out);
		let h = 0;
		for (let i = 0; i < str.length; i++) {
			h = (Math.imul(h, 31) + str.charCodeAt(i)) | 0;
		}
		// Golden hash computed with matchEvents from commit 5104c9b (before the extraction).
		expect(h).toBe(1424526934);
		expect(s).toEqual({
			fitness: 0,
			form: 0,
			yellowCount: 77,
			suspendedFor: 5,
			injuredFor: 21,
		});
	});

	it("eventProbabilities zgodne z formula kartek i kontuzji", () => {
		const p = eventProbabilities(player(20));
		const factor = Math.exp((STATE_MODEL.disciplineSlope * 30) / 50);
		expect(p.yellow).toBeCloseTo(STATE_MODEL.yellowBase * factor, 12);
		expect(p.red).toBeCloseTo(STATE_MODEL.redBase * factor, 12);
		expect(p.secondYellowShare).toBe(STATE_MODEL.secondYellowShare);
		expect(p.injury).toBe(STATE_MODEL.injuryRate);
	});

	it("applyLiveOutcome: koszt kondycji proporcjonalny do minut", () => {
		const none = { yellow: false, red: "none" as const, injured: 0 };
		const s = { ...freshState(), fitness: 80 };
		expect(applyLiveOutcome(s, { ...none, minutes: 90 }, 1).fitness).toBe(
			80 - STATE_MODEL.fitnessCost,
		);
		expect(
			applyLiveOutcome(s, { ...none, minutes: 30 }, 1).fitness,
		).toBeCloseTo(80 - STATE_MODEL.fitnessCost / 3, 10);
		expect(applyLiveOutcome(s, { ...none, minutes: 0 }, 1).fitness).toBe(80);
	});

	it("applyLiveOutcome: kary jak w matchEvents", () => {
		const base = { injured: 0, minutes: 90 };
		const fifth = applyLiveOutcome(
			{ ...freshState(), yellowCount: 4 },
			{ ...base, yellow: true, red: "none" },
			19,
		);
		expect(fifth.yellowCount).toBe(5);
		expect(fifth.suspendedFor).toBe(1);
		const second = applyLiveOutcome(
			{ ...freshState(), yellowCount: 4 },
			{ ...base, yellow: true, red: "second-yellow" },
			10,
		);
		expect(second.yellowCount).toBe(4);
		expect(second.suspendedFor).toBe(1);
		const straight = applyLiveOutcome(
			freshState(),
			{ ...base, yellow: false, red: "straight" },
			10,
		);
		expect(straight.suspendedFor).toBe(3);
		const injured = applyLiveOutcome(
			{ ...freshState(), injuredFor: 5 },
			{ yellow: false, red: "none", injured: 2, minutes: 20 },
			10,
		);
		expect(injured.injuredFor).toBe(5);
		expect(
			applyLiveOutcome(
				freshState(),
				{ yellow: false, red: "none", injured: 4, minutes: 20 },
				10,
			).injuredFor,
		).toBe(4);
	});
});
