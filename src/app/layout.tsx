import "~/styles/globals.css";

import type { Metadata } from "next";
import { Geist } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";

import { LocaleSwitcher } from "~/app/_components/locale-switcher";
import { TRPCReactProvider } from "~/trpc/react";

export async function generateMetadata(): Promise<Metadata> {
	const t = await getTranslations("meta");
	return {
		title: "Dugout",
		description: t("description"),
		icons: [{ rel: "icon", url: "/favicon.ico" }],
	};
}

const geist = Geist({
	subsets: ["latin"],
	variable: "--font-geist-sans",
});

export default async function RootLayout({
	children,
}: Readonly<{ children: React.ReactNode }>) {
	const locale = await getLocale();
	return (
		<html className={`${geist.variable}`} lang={locale}>
			<body>
				<NextIntlClientProvider>
					<LocaleSwitcher />
					<TRPCReactProvider>{children}</TRPCReactProvider>
				</NextIntlClientProvider>
			</body>
		</html>
	);
}
