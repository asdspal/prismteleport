import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { Inter, JetBrains_Mono } from "next/font/google";
import { NetworkStatus } from "@/components/NetworkStatus";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "PrismTeleport — Bitcoin Fixed Carry Terminal",
  description:
    "Fixed-carry Bitcoin banking and sMUSD yield stripping on Mezo.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0B0E14",
};

const NAV = [
  { href: "/", label: "Terminal" },
  { href: "/prism", label: "Prism" },
  { href: "/teleport", label: "Teleport" },
  { href: "/stake", label: "Stake" },
  { href: "/evidence", label: "Evidence" },
];

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrains.variable}`}>
      <body className="min-h-screen bg-bg-primary text-text-primary">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-bg-surface focus:px-4 focus:py-2 focus:text-text-primary"
        >
          Skip to content
        </a>

        <header className="border-b border-border-default bg-bg-primary">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <div className="flex min-w-0 flex-wrap items-center gap-3">
              <Link
                href="/"
                className="font-mono text-sm font-semibold tracking-[0.12em] text-text-primary"
              >
                PRISM
                <span className="text-brand-cyan">{"//"}</span>
                TELEPORT
              </Link>
              <span className="rounded-full border border-border-default px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-text-secondary">
                Mezo Wave 2
              </span>
            </div>

            <nav
              aria-label="Primary"
              className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm"
            >
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="rounded-sm py-1 text-text-secondary transition-colors hover:text-text-primary"
                >
                  {item.label}
                </Link>
              ))}
            </nav>

            <NetworkStatus />
          </div>
        </header>

        {children}

        <footer className="mt-12 border-t border-border-default">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 px-4 py-6 text-xs text-text-secondary sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <p>
              Read-only shell. Contracts, relayer, and live series deploy in
              Milestone 1.
            </p>
            <p className="font-mono">
              Mezo Testnet 31611 · Base Sepolia 84532
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
