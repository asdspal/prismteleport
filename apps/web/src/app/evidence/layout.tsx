import type { ReactNode } from "react";
import { PrismClientProviders } from "@/providers/clientBoundary";

/** The playground embeds the wallet-aware SDK widget, so this segment mounts with wallets. */
export default function EvidenceLayout({ children }: { children: ReactNode }) {
  return <PrismClientProviders>{children}</PrismClientProviders>;
}
