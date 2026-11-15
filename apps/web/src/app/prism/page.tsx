"use client";

import { useAccount } from "wagmi";
import { usePrismMarketsAndPortfolio } from "@/hooks/usePrismMarketsAndPortfolio";
import { useJudgeMode } from "@/providers/judgeMode";
import { usePrismNetwork } from "@/providers/PrismWeb3Provider";
import { DualTrackAndFeeSimulatorCard } from "@/components/prism/DualTrackAndFeeSimulatorCard";
import { OneSignBorrowAndLockCard } from "@/components/prism/OneSignBorrowAndLockCard";
import { PtYtSwapAndMintCard } from "@/components/prism/PtYtSwapAndMintCard";
import { formatBps, formatMusd, parseAmount } from "@/lib/carry";

/**
 * Prism fixed-income terminal (R-001..R-006, R-012..R-014): the 1-signature
 * borrow & lock, PT/YT swap-mint-redeem, and the dual-track sMUSD monitor with
 * the testnet fee simulator.
 */
export default function PrismTerminalPage() {
  const { address, isConnected } = useAccount();
  const { resolveActiveAddress, judgeMode } = useJudgeMode();
  const { chainId } = usePrismNetwork();
  const activeAddress = resolveActiveAddress(address);

  const { markets, portfolio, source, loading, error, blockNumber } =
    usePrismMarketsAndPortfolio(activeAddress, chainId);

  return (
    <main id="main" className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-brand-cyan">
            Prism fixed-income terminal
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-text-primary sm:text-3xl">
            Borrow once. Lock the carry.
          </h1>
        </div>
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-tertiary">
          {source === "onchain" ? "direct on-chain RPC mode" : "indexed api"}
          {blockNumber ? ` · block #${blockNumber}` : ""}
          {loading ? " · loading" : ""}
        </span>
      </header>

      {error ? <p className="mt-4 text-xs text-brand-amber">{error}</p> : null}

      <section
        aria-label="Your position"
        className="mt-6 rounded-lg border border-border-default bg-bg-surface/60 p-4 sm:p-5"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-text-secondary">
            {judgeMode ? "Demo position" : "Your position"}
          </h2>
          <span className="font-mono text-[10px] text-text-tertiary">
            {activeAddress ? `${activeAddress.slice(0, 6)}…${activeAddress.slice(-4)}` : "not connected"}
          </span>
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-5">
          <div className="flex flex-col gap-0.5">
            <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-tertiary">
              Trove collateral
            </dt>
            <dd className="font-mono text-sm tabular-nums text-text-primary">
              {portfolio ? `${Number(portfolio.troveCollateralBtc).toFixed(4)} BTC` : "—"}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-tertiary">
              Trove debt
            </dt>
            <dd className="font-mono text-sm tabular-nums text-text-primary">
              {portfolio ? `${formatMusd(parseAmount(portfolio.troveDebtMusd), 2)} MUSD` : "—"}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-tertiary">
              ICR
            </dt>
            <dd className="font-mono text-sm tabular-nums text-text-primary">
              {portfolio && portfolio.troveIcrBps > 0 ? formatBps(portfolio.troveIcrBps) : "—"}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-tertiary">
              PT / YT
            </dt>
            <dd className="font-mono text-sm tabular-nums text-text-primary">
              {portfolio
                ? `${formatMusd(parseAmount(portfolio.ptBalance), 2)} / ${formatMusd(parseAmount(portfolio.ytBalance), 2)}`
                : "—"}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-tertiary">
              Staked MEZO
            </dt>
            <dd className="font-mono text-sm tabular-nums text-text-primary">
              {portfolio ? `${formatMusd(parseAmount(portfolio.stakedMezoBalance), 2)}` : "—"}
            </dd>
          </div>
        </dl>
        {!isConnected && !judgeMode ? (
          <p className="mt-3 text-xs text-text-tertiary">
            Connect a wallet, or turn on &ldquo;Inspect Live Demo Trove&rdquo; in the
            header to browse a live funded position.
          </p>
        ) : null}
      </section>

      <div className="mt-5 flex flex-col gap-5">
        <OneSignBorrowAndLockCard
          chainId={chainId}
          markets={markets}
          portfolio={portfolio}
          blockNumber={blockNumber}
        />
        <PtYtSwapAndMintCard
          markets={markets}
          portfolio={portfolio}
          blockNumber={blockNumber}
        />
        <DualTrackAndFeeSimulatorCard />
      </div>
    </main>
  );
}
