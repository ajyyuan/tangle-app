import type { Metadata } from "next";
import "@xyflow/react/dist/style.css";
import "./globals.css";

const description = "A quiet personal task list with visual dependencies.";
const siteUrl = "https://carpaccio.io";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "Carpaccio",
    template: "%s · Carpaccio",
  },
  description,
  applicationName: "Carpaccio",
  category: "productivity",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "Carpaccio",
    title: "Carpaccio — Tasks, clearly connected",
    description,
  },
  twitter: {
    card: "summary_large_image",
    title: "Carpaccio — Tasks, clearly connected",
    description,
  },
};

const appearanceScript = `
(() => {
  try {
    const saved = localStorage.getItem("carpaccio-appearance-v1");
    const theme = saved === "light" || saved === "dark" ? saved : "system";
    const resolved = theme === "system"
      ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
      : theme;
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.resolvedTheme = resolved;
    document.documentElement.style.colorScheme = resolved;
  } catch {
    const resolved = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    document.documentElement.dataset.theme = "system";
    document.documentElement.dataset.resolvedTheme = resolved;
    document.documentElement.style.colorScheme = resolved;
  }
})();`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: appearanceScript }} /></head>
      <body>{children}</body>
    </html>
  );
}
