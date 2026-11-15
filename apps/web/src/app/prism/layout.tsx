import type { ReactNode } from "react";
import { PrismClientProviders } from "@/providers/clientBoundary";

/**
 * `/prism` is the wallet-bearing terminal, so the whole segment mounts inside the
 * client-only wallet boundary (the landing stays wallet-free).
 */
export default function PrismLayout({ children }: { children: ReactNode }) {
  return <PrismClientProviders>{children}</PrismClientProviders>;
}
