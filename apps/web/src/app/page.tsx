"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { BtcShockSimulator } from "@/components/calculator/BtcShockSimulator";
import { FixedCarryCalculator } from "@/components/calculator/FixedCarryCalculator";
import { PasteAnyTroveInspector } from "@/components/calculator/TroveInspector";
import { usePrismMarketsAndPortfolio } from "@/hooks/usePrismMarketsAndPortfolio";
import {
  formatBps,
  formatMusd,
  parseAmount,
  quotePtOut,
  secondsToMaturity,
} from "@/lib/carry";

/**
 * Landing screen (R-016, R-022): the read-only fixed carry spread calculator,
 * the BTC shock simulator, a live series comparison table and the paste-any-Trove
 * inspector. Works with no wallet connected and cites the block every figure was
 * read at.
 */

export default function HomePage() {
  // The landing is deliberately wallet-free (R-016): no wagmi, no Passport, just
  // live reads. The header wallet bar loads separately.
  const [chainId, setChainId] = useState(31611);
  const { markets, source, loading, error, blockNumber } =
    usePrismMarketsAndPortfolio(undefined, chainId);

  const [borrowInput] = useState("2000");
  const borrow = useMemo(() => parseAmount(borrowInput), [borrowInput]);
  const nowSeconds = Math.floor(Date.now() / 1000);

  const lockPreviews = useMemo(() => {
    if (!markets) return [];
    return markets.series.map((series) => {
      const timeToMaturity = secondsToMaturity(series.maturityTimestamp, nowSeconds);
      const ptPrice = series.ptPriceWei ? BigInt(series.ptPriceWei) : 0n;
      return {
        series,
        timeToMaturity,
        ptOut: ptPrice > 0n ? quotePtOut(borrow, ptPrice) : 0n,
      };
    });
  }, [markets, borrow, nowSeconds]);

  return (
    <main id="main" className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
      <section aria-labelledby="hero-heading" className="max-w-3xl">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-brand-cyan">
          Bitcoin fixed carry · Mezo
        </p>
        <h1
          id="hero-heading"
          className="mt-3 text-3xl font-semibold tracking-tight text-text-primary sm:text-4xl"
        >
          Strip sMUSD yield. Lock the carry.
        </h1>
        <p className="mt-3 text-sm text-text-secondary">
          Borrow MUSD against your BTC, lock it into fixed-rate PT-sMUSD, and keep
          the guaranteed spread between the Prism fixed rate and your Trove borrow
          rate. Read-only: every figure below comes from Mezo Testnet 31611.
        </p>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Link
            href="/prism"
            className="rounded-md border border-brand-cyan px-4 py-2 font-mono text-[11px] uppercase tracking-[0.14em] text-brand-cyan transition-colors hover:bg-brand-cyan/10"
          >
            Open the Prism terminal
          </Link>
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-tertiary">
              {source === "onchain" ? "direct on-chain RPC mode" : "indexed api"}
              {blockNumber ? ` · block #${blockNumber}` : ""}
              {loading ? " · loading" : ""}
            </span>
            <div className="flex items-center gap-1 rounded-full border border-border-default p-0.5">
              {[31611, 31612].map((id) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={chainId === id}
                  onClick={() => setChainId(id)}
                  className={`rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] transition-colors ${
                    chainId === id
                      ? "bg-bg-surface text-text-primary"
                      : "text-text-secondary hover:text-text-primary"
                  }`}
                >
                  {id === 31611 ? "Testnet 31611" : "Mainnet 31612"}
                </button>
              ))}
            </div>
          </div>
        </div>
        {error ? <p className="mt-3 text-xs text-brand-amber">{error}</p> : null}
      </section>

      <div className="mt-8 grid gap-5 lg:grid-cols-2">
        <FixedCarryCalculator markets={markets} blockNumber={blockNumber} />
        <BtcShockSimulator
          markets={markets}
          collateralBtcWei={parseAmount("0.05")}
          debtMusdWei={borrow}
          ptOutWei={lockPreviews[0]?.ptOut}
          blockNumber={blockNumber}
        />
      </div>

      <section
        aria-labelledby="series-heading"
        className="mt-5 rounded-lg border border-border-default bg-bg-surface/60 p-4 sm:p-5"
      >
        <header className="flex flex-wrap items-baseline justify-between gap-2">
          <h2
            id="series-heading"
            className="font-mono text-[11px] uppercase tracking-[0.18em] text-text-secondary"
          >
            Live series comparison
          </h2>
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-tertiary">
            {blockNumber ? `PrismTokenizer + PrismYieldAMM @ block #${blockNumber}` : "live chain read"}
          </span>
        </header>

        <div
          className="mt-4 overflow-x-auto"
          tabIndex={0}
          role="region"
          aria-label="Live series comparison table"
        >
          <table className="w-full min-w-[640px] border-collapse text-left">
            <thead>
              <tr className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-tertiary">
                <th className="py-1 font-normal">Series</th>
                <th className="py-1 font-normal">PT fixed APY</th>
                <th className="py-1 font-normal">YT implied APY</th>
                <th className="py-1 font-normal">Net carry vs Trove APR</th>
                <th className="py-1 font-normal">PT price</th>
                <th className="py-1 font-normal">{formatMusd(borrow, 0)} MUSD buys</th>
                <th className="py-1 font-normal">Adapter</th>
              </tr>
            </thead>
            <tbody className="font-mono text-xs text-text-primary">
              {lockPreviews.map(({ series, ptOut, timeToMaturity }) => (
                <tr key={series.maturityTimestamp} className="border-t border-border-default">
                  <td className="py-2">
                    {new Date(series.maturityTimestamp * 1000).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                    <span className="ml-2 text-text-tertiary">
                      {(Number(timeToMaturity) / 86_400).toFixed(0)}d
                    </span>
                  </td>
                  <td className="py-2 tabular-nums">{formatBps(series.fixedPtApyBps)}</td>
                  <td className="py-2 tabular-nums">{formatBps(series.impliedYtApyBps)}</td>
                  <td className="py-2 tabular-nums text-brand-cyan">
                    {formatBps(series.netCarrySpreadBps)}
                  </td>
                  <td className="py-2 tabular-nums">
                    {series.ptPriceWei
                      ? formatMusd(BigInt(series.ptPriceWei), 6)
                      : "—"}
                  </td>
                  <td className="py-2 tabular-nums">{formatMusd(ptOut, 4)} PT</td>
                  <td className="py-2 text-text-secondary">{series.activeAdapterMode}</td>
                </tr>
              ))}
              {lockPreviews.length === 0 ? (
                <tr>
                  <td className="py-2 text-text-tertiary" colSpan={7}>
                    {loading ? "Loading live series…" : "No active series on this chain."}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <div className="mt-5">
        <PasteAnyTroveInspector chainId={chainId} />
      </div>
    </main>
  );
}
