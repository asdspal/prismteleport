import type { ReactNode } from "react";
import { PrismClientProviders } from "@/providers/clientBoundary";

/** `/stake` writes to Mezo, so this segment mounts inside the wallet boundary. */
export default function StakeLayout({ children }: { children: ReactNode }) {
  return <PrismClientProviders>{children}</PrismClientProviders>;
}
