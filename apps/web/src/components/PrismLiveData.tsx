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

function formatUsd(value: string): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;
  return numeric.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

export function MarketStrip() {
  const { markets, portfolio, source, loading, error, activeAddress, judgeMode } =
    useActivePrismData();

  return (
    <section
      aria-label="Live Prism market data"
      className="rounded-lg border border-border-default bg-bg-surface/60 p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.18em] text-text-secondary">
          {judgeMode ? "Inspecting demo trove" : "Live market"}
          {activeAddress ? (
            <span className="ml-2 text-text-tertiary normal-case tracking-normal">
              {activeAddress.slice(0, 6)}…{activeAddress.slice(-4)}
            </span>
          ) : null}
        </h2>
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-text-tertiary">
          {source === "onchain" ? "direct on-chain RPC" : "indexed api"}
          {loading ? " · loading" : ""}
        </p>
      </div>

      {error ? (
        <p className="mt-3 text-xs text-brand-amber">{error}</p>
      ) : null}

      <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <dt className="text-[10px] uppercase tracking-[0.14em] text-text-tertiary">
            BTC / USD
          </dt>
          <dd className="font-mono text-sm text-text-primary">
            {markets ? formatUsd(markets.btcPriceUsd) : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-[0.14em] text-text-tertiary">
            Trove borrow APR
          </dt>
          <dd className="font-mono text-sm text-text-primary">
            {markets ? formatBps(markets.troveFixedBorrowAprBps) : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-[0.14em] text-text-tertiary">
            Trove ICR
          </dt>
          <dd className="font-mono text-sm text-text-primary">
            {portfolio && portfolio.troveIcrBps > 0
              ? formatBps(portfolio.troveIcrBps)
              : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-[0.14em] text-text-tertiary">
            PT / YT held
          </dt>
          <dd className="font-mono text-sm text-text-primary">
            {portfolio ? `${Number(portfolio.ptBalance).toFixed(2)} / ${Number(portfolio.ytBalance).toFixed(2)}` : "—"}
          </dd>
        </div>
      </dl>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[520px] border-collapse text-left">
          <thead>
            <tr className="text-[10px] uppercase tracking-[0.14em] text-text-tertiary">
              <th className="py-1 font-normal">Maturity</th>
              <th className="py-1 font-normal">PT fixed APY</th>
              <th className="py-1 font-normal">YT implied APY</th>
              <th className="py-1 font-normal">Net carry</th>
              <th className="py-1 font-normal">Adapter</th>
            </tr>
          </thead>
          <tbody className="font-mono text-xs text-text-primary">
            {(markets?.series ?? []).map((series) => (
              <tr key={series.maturityTimestamp} className="border-t border-border-default">
                <td className="py-1.5">
                  {new Date(series.maturityTimestamp * 1000).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })}
                </td>
                <td className="py-1.5">{formatBps(series.fixedPtApyBps)}</td>
                <td className="py-1.5">{formatBps(series.impliedYtApyBps)}</td>
                <td className="py-1.5 text-brand-cyan">
                  {formatBps(series.netCarrySpreadBps)}
                </td>
                <td className="py-1.5 text-text-secondary">
                  {series.activeAdapterMode}
                </td>
              </tr>
            ))}
            {!markets || markets.series.length === 0 ? (
              <tr>
                <td className="py-2 text-text-tertiary" colSpan={5}>
                  {loading ? "Loading live series…" : "No active series on this chain."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
