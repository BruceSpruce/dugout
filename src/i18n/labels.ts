// Id lists behind the translated labels (`labels.*` in messages): the text lives in messages,
// only the ids and their order live here. Pure module, no Next.js imports.

import type { Position } from "~/engine/attributes";
import type { Style } from "~/engine/tactics";

/** Play styles in the order the style pickers show them. */
export const STYLE_IDS: readonly Style[] = [
	"attacking",
	"balanced",
	"defensive",
];

export const isStyle = (x: string): x is Style =>
	(STYLE_IDS as readonly string[]).includes(x);

/** Position groups in squad order: goalkeepers first. */
export const POSITION_IDS: readonly Position[] = [
	"Goalkeeper",
	"Defender",
	"Midfielder",
	"Attacker",
];
