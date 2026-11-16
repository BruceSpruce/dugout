"use client";

import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useTransition } from "react";

import { setLocale } from "~/i18n/actions";
import { LOCALES, type Locale } from "~/i18n/locale";

const LABEL: Record<Locale, string> = { pl: "PL", en: "EN" };

export function LocaleSwitcher() {
	const t = useTranslations("common");
	const current = useLocale();
	const router = useRouter();
	const [pending, startTransition] = useTransition();

	function choose(locale: Locale) {
		if (locale === current) return;
		startTransition(async () => {
			await setLocale(locale);
			router.refresh();
		});
	}

	return (
		<fieldset
			aria-label={t("language")}
			className="fixed top-3 right-3 z-50 flex overflow-hidden rounded-md border border-white/20 bg-[#071a0e]/80 text-xs font-bold text-white shadow"
		>
			{LOCALES.map((locale) => {
				const active = locale === current;
				return (
					<button
						aria-label={t(locale === "pl" ? "switchToPl" : "switchToEn")}
						aria-pressed={active}
						className={
							active
								? "bg-green-500 px-2 py-1 text-[#071a0e]"
								: "px-2 py-1 text-green-100 hover:bg-white/10 disabled:opacity-50"
						}
						disabled={pending}
						key={locale}
						onClick={() => choose(locale)}
						type="button"
					>
						{LABEL[locale]}
					</button>
				);
			})}
		</fieldset>
	);
}
