// Pure locale helpers: no Next.js imports, so they can be unit-tested.

export const LOCALES = ["pl", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_COOKIE = "locale";

export function isLocale(value: unknown): value is Locale {
	return (
		typeof value === "string" && (LOCALES as readonly string[]).includes(value)
	);
}

/**
 * Picks the language with the highest q-value from an Accept-Language header
 * (ties keep header order). Returns null for an empty or unparsable header.
 */
function topLanguage(acceptLanguage: string): string | null {
	let best: { tag: string; q: number } | null = null;
	for (const part of acceptLanguage.split(",")) {
		const [rawTag, ...params] = part.trim().split(";");
		const tag = rawTag?.trim().toLowerCase();
		if (!tag) continue;
		let q = 1;
		for (const param of params) {
			const [key, value] = param.trim().split("=");
			if (key?.trim() === "q" && value !== undefined) {
				const parsed = Number.parseFloat(value);
				q = Number.isNaN(parsed) ? 0 : parsed;
			}
		}
		if (q <= 0) continue;
		if (best === null || q > best.q) best = { tag, q };
	}
	return best?.tag ?? null;
}

/**
 * Cookie wins when it holds a supported locale. Otherwise Polish when the
 * browser's highest-priority language is Polish, else the default (English).
 */
export function resolveLocale(
	cookie?: string | null,
	acceptLanguage?: string | null,
): Locale {
	if (isLocale(cookie)) return cookie;
	const top = acceptLanguage ? topLanguage(acceptLanguage) : null;
	if (top?.startsWith("pl")) return "pl";
	return DEFAULT_LOCALE;
}
