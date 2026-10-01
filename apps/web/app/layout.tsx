import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";

import { appBootstrapScript } from "client/state/app";
import { DEFAULT_APP_ID, getApp } from "shared/apps";
import { themeBootstrapScript } from "client/themes/bootstrap";
import { DEFAULT_ACCENT, DEFAULT_MODE } from "client/themes/palette";
import Providers from "client/ui/Providers";

/** Self-hosted variable fonts (OFL, licences in public/fonts). next/font serves them from /_next/static. */
const inter = localFont({
  src: "../public/fonts/inter-latin-wght.woff2",
  variable: "--font-inter",
  weight: "100 900",
  display: "swap",
});
const jetbrainsMono = localFont({
  src: "../public/fonts/jetbrains-mono-latin-wght.woff2",
  variable: "--font-jetbrains-mono",
  weight: "100 800",
  display: "swap",
});

export const metadata: Metadata = {
  // The default app's; AppBoot sets the tab title to the active app's name.
  title: getApp(DEFAULT_APP_ID).name,
  description: getApp(DEFAULT_APP_ID).question,
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

/**
 * Sets data-theme, data-accent and the accent vars from storage before first paint, so a light or tactical
 * user never sees the dark default flash. Server HTML carries the defaults; the script may change them before
 * React hydrates, hence suppressHydrationWarning on <html>.
 */
const THEME_BOOTSTRAP = themeBootstrapScript();

/**
 * Resolves the app (`?app=`, share link, localStorage, carp) before first paint. Server HTML is the default app;
 * when the resolved one differs the page stays hidden until AppBoot has switched after hydration (PLAN.md C-A5).
 */
const APP_BOOTSTRAP = appBootstrapScript();
const APP_PENDING_CSS = "html[data-app-pending] body{visibility:hidden}";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      data-theme={DEFAULT_MODE}
      data-accent={DEFAULT_ACCENT}
      className={`${inter.variable} ${jetbrainsMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script id="theme-bootstrap" dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
        <style id="app-pending" dangerouslySetInnerHTML={{ __html: APP_PENDING_CSS }} />
        <script id="app-bootstrap" dangerouslySetInnerHTML={{ __html: APP_BOOTSTRAP }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
