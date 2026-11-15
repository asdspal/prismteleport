import type { ReactNode } from "react";
import { PrismClientProviders } from "@/providers/clientBoundary";

/** `/teleport` signs intents and can claim rescue BTC, so it mounts with wallets. */
export default function TeleportLayout({ children }: { children: ReactNode }) {
  return <PrismClientProviders>{children}</PrismClientProviders>;
}
