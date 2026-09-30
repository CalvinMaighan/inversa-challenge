import type { ReactNode } from "react";

export const metadata = {
  title: "Everglades Ops",
  description: "Where are invasive species active across South Florida right now, and where should removal crews go next?",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
