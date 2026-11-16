import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";

import { LOCALE_COOKIE, resolveLocale } from "./locale";

export default getRequestConfig(async () => {
	const cookieStore = await cookies();
	const headerList = await headers();
	const locale = resolveLocale(
		cookieStore.get(LOCALE_COOKIE)?.value,
		headerList.get("accept-language"),
	);
	return {
		locale,
		messages: (await import(`../../messages/${locale}.json`)).default,
		timeZone: "Europe/Warsaw",
	};
});
