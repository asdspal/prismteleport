"use client";

import type { Address } from "viem";
import { useAccount } from "wagmi";
import { usePrismMarketsAndPortfolio } from "@/hooks/usePrismMarketsAndPortfolio";
import { useJudgeMode } from "@/providers/judgeMode";
import { usePrismNetwork } from "@/providers/PrismWeb3Provider";
import { WalletAndJudgeBar } from "@/components/wallet/WalletAndJudgeBar";

/**
 * Client glue between the wallet/judge state and the API-first data hook, so the
 * header bar and the landing strip always describe the same live position — the
 * connected wallet's, or the Step 1.5 demo trove while a judge is inspecting.
 */

function useActivePrismData() {
  const { address } = useAccount();
  const { chainId } = usePrismNetwork();
  const { resolveActiveAddress, judgeMode } = useJudgeMode();
  const activeAddress = resolveActiveAddress(address as Address | undefined);
  const data = usePrismMarketsAndPortfolio(activeAddress, chainId);
  return { ...data, activeAddress, judgeMode };
}

export function TerminalStatusBar() {
  const { source, portfolio } = useActivePrismData();
  return (
    <WalletAndJudgeBar source={source} icrBps={portfolio?.troveIcrBps} />
  );
}
