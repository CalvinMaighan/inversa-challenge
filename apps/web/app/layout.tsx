import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";

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
  title: "Everglades Ops",
  description: "Where are invasive species active across South Florida right now, and where should removal crews go next?",
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
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
