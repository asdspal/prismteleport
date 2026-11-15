"use client";

import { useMemo, useState } from "react";
import type { MarketsView } from "@/hooks/usePrismMarketsAndPortfolio";
import {
  applyPriceShock,
  computeIcrBps,
  formatBps,
  formatMusd,
  formatUsd,
  icrBand,
  liquidationPriceUsdWei,
  parseAmount,
  type IcrBand,
} from "@/lib/carry";

/**
 * What-if BTC shock simulator (R-016): shows that a locked PT position still
 * redeems at par (1.00 MUSD per PT) at maturity even if BTC drops, and how far
 * the Trove's health buffer can absorb a price move before liquidation.
 */

const BAND_STYLES: Record<IcrBand, string> = {
  safe: "text-brand-cyan",
  caution: "text-brand-amber",
  blocked: "text-red-400",
};

export function BtcShockSimulator({
  markets,
  collateralBtcWei,
  debtMusdWei,
  ptOutWei,
  blockNumber,
}: {
  markets?: MarketsView;
  collateralBtcWei?: bigint;
  debtMusdWei?: bigint;
  ptOutWei?: bigint;
  blockNumber?: number;
}) {
  const [shockPercent, setShockPercent] = useState(-30);

  const model = useMemo(() => {
    if (!markets) return undefined;
    const price = parseAmount(markets.btcPriceUsd);
    if (price <= 0n) return undefined;

    const shockBps = BigInt(Math.round(shockPercent * 100));
    const shockedPrice = applyPriceShock(price, shockBps);
    const collateral = collateralBtcWei ?? parseAmount("0.05");
    const debt = debtMusdWei ?? parseAmount("2000");
    const icr = computeIcrBps(collateral, debt, shockedPrice);
    const liquidation = liquidationPriceUsdWei(collateral, debt);

    return {
      shockedPrice,
      icr,
      band: icrBand(icr),
      liquidation,
      liquidationMovePercent:
        price > 0n
          ? Number(((liquidation - price) * 10_000n) / price) / 100
          : 0,
    };
  }, [markets, shockPercent, collateralBtcWei, debtMusdWei]);

  const ptOut = ptOutWei ?? 0n;

  return (
    <section
      aria-labelledby="shock-heading"
      className="rounded-lg border border-border-default bg-bg-surface/60 p-4 sm:p-5"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2
          id="shock-heading"
          className="font-mono text-[11px] uppercase tracking-[0.18em] text-text-secondary"
        >
          What if BTC moves?
        </h2>
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-tertiary">
          {blockNumber ? `TroveManager @ block #${blockNumber}` : "live chain read"}
        </span>
      </header>

      <div className="mt-4 flex flex-col gap-2">
        <label className="flex items-center justify-between gap-3">
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-text-tertiary">
            BTC price move
          </span>
          <span className="font-mono text-sm tabular-nums text-text-primary">
            {shockPercent > 0 ? "+" : ""}
            {shockPercent}%
          </span>
        </label>
        <input
          type="range"
          min={-40}
          max={40}
          step={1}
          value={shockPercent}
          aria-label="BTC price move in percent"
          onChange={(event) => setShockPercent(Number(event.target.value))}
          className="w-full accent-[color:var(--brand-cyan,#22d3ee)]"
        />
        <div className="flex justify-between font-mono text-[10px] text-text-tertiary">
          <span>-40%</span>
          <span>0%</span>
          <span>+40%</span>
        </div>
      </div>

      {!model ? (
        <p className="mt-4 text-xs text-text-tertiary">Loading live BTC price…</p>
      ) : (
        <>
          <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
            <div className="flex flex-col gap-0.5">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-tertiary">
                Shocked BTC price
              </span>
              <span className="font-mono text-sm tabular-nums text-text-primary">
                ${formatUsd(model.shockedPrice)}
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-tertiary">
                Trove ICR
              </span>
              <span
                className={`font-mono text-sm tabular-nums ${BAND_STYLES[model.band]}`}
              >
                {formatBps(model.icr)}
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-tertiary">
                Liquidation price
              </span>
              <span className="font-mono text-sm tabular-nums text-text-primary">
                ${formatUsd(model.liquidation)}
              </span>
              <span className="text-[10px] text-text-tertiary">
                {model.liquidationMovePercent >= 0 ? "+" : ""}
                {model.liquidationMovePercent.toFixed(1)}% from spot
              </span>
            </div>
          </dl>

          <div className="mt-4 rounded-md border border-border-default bg-bg-primary/60 p-3">
            <p className="text-xs text-text-secondary">
              Your locked principal is immune to the BTC move:{" "}
              <span className="font-mono text-brand-cyan">
                {ptOut > 0n ? formatMusd(ptOut, 4) : "—"} PT-sMUSD
              </span>{" "}
              redeems for exactly{" "}
              <span className="font-mono text-text-primary">1.00 MUSD per PT</span>{" "}
              at maturity, and that par value can repay Trove debt 1:1 regardless of
              the BTC price.
            </p>
          </div>
        </>
      )}
    </section>
  );
}
