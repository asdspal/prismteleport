"use client";

import dynamic from "next/dynamic";
import type { ReactNode } from "react";

/**
 * Client-only boundary for the wallet stack.
 *
 * Mezo Passport's dependency chain (orangekit → smart account → Gelato relay
 * SDK) touches `window` while the module is evaluated, which breaks Next's
 * prerender on the server. Everything that needs a wallet therefore loads with
 * `ssr: false` and hydrates on the client, while the page shell stays static.
 */

const PrismWeb3Provider = dynamic(
  () => import("./PrismWeb3Provider").then((module) => module.PrismWeb3Provider),
  { ssr: false },
);

const TerminalStatusBar = dynamic(
  () =>
    import("@/components/PrismLiveData").then((module) => module.TerminalStatusBar),
  { ssr: false },
);

export function PrismClientProviders({ children }: { children: ReactNode }) {
  return <PrismWeb3Provider>{children}</PrismWeb3Provider>;
}

export function ClientStatusBar() {
  return <TerminalStatusBar />;
}
