import type { Metadata } from "next";
import "@xyflow/react/dist/style.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tangle",
  description: "A quiet task list with visual dependencies.",
};

const appearanceScript = `
(() => {
  try {
    const saved = localStorage.getItem("tangle-appearance-v1");
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
