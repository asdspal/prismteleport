"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount } from "wagmi";
import { useJudgeMode } from "@/providers/judgeMode";
import { MEZO_CHAIN_IDS, usePrismNetwork } from "@/providers/PrismWeb3Provider";
import type { DataSource } from "@/hooks/usePrismMarketsAndPortfolio";

/**
 * Responsive wallet bar: connect button, live Trove ICR badge, Testnet/Mainnet
 * switcher and the 1-click "Inspect Live Demo Trove" toggle for judges (R-015,
 * R-016). Also surfaces the "Direct On-Chain RPC Mode" badge when the API is
 * down and the hook has fallen back to browser Multicall3 reads.
 */

function truncate(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function WalletAndJudgeBar({
  source,
  icrBps,
}: {
  source?: DataSource;
  icrBps?: number;
}) {
  const { judgeMode, toggleJudgeMode, demoAddress } = useJudgeMode();
  const { address, isConnected } = useAccount();
  const { isTestnet, isSwitching, switchTo } = usePrismNetwork();

  const icrLabel =
    typeof icrBps === "number" && icrBps > 0
      ? `${(icrBps / 100).toFixed(2)}%`
      : "—";

  return (
    <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
      {source === "onchain" ? (
        <span
          title="The Fastify API was unreachable, so values are read directly from Mezo via Multicall3."
          className="rounded-full border border-brand-amber px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-brand-amber"
        >
          Direct On-Chain RPC Mode
        </span>
      ) : null}

      <span
        title="Trove collateralization ratio (Mezo TroveManager)"
        className="rounded-full border border-border-default px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-text-secondary"
      >
        ICR {icrLabel}
      </span>

      <div className="flex items-center gap-1 rounded-full border border-border-default p-0.5">
        {(
          [
            { id: MEZO_CHAIN_IDS.testnet, label: "Testnet 31611" },
            { id: MEZO_CHAIN_IDS.mainnet, label: "Mainnet 31612" },
          ] as const
        ).map((network) => {
          const active =
            network.id === MEZO_CHAIN_IDS.testnet ? isTestnet : !isTestnet;
          return (
            <button
              key={network.id}
              type="button"
              disabled={!isConnected || isSwitching}
              aria-pressed={active}
              onClick={() => switchTo(network.id)}
              className={`rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] transition-colors ${
                active
                  ? "bg-bg-surface text-text-primary"
                  : "text-text-secondary hover:text-text-primary"
              } disabled:cursor-not-allowed disabled:opacity-50`}
            >
              {network.label}
            </button>
          );
        })}
      </div>

      <button
        type="button"
        aria-pressed={judgeMode}
        onClick={toggleJudgeMode}
        title={`Inspect ${demoAddress} with no wallet`}
        className={`rounded-full border px-3 py-1 font-mono text-[10px] uppercase tracking-[0.14em] transition-colors ${
          judgeMode
            ? "border-brand-cyan text-brand-cyan"
            : "border-border-default text-text-secondary hover:text-text-primary"
        }`}
      >
        {judgeMode ? `Inspecting ${truncate(demoAddress)}` : "Inspect Live Demo Trove"}
      </button>

      <ConnectButton
        showBalance={false}
        chainStatus="icon"
        accountStatus={{ smallScreen: "avatar", largeScreen: "address" }}
      />

      {isConnected && address && !judgeMode ? (
        <span className="hidden font-mono text-[10px] text-text-secondary sm:inline">
          {truncate(address)}
        </span>
      ) : null}
    </div>
  );
}
