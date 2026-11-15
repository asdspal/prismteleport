"use client";

import { useMemo, useState } from "react";
import type { MarketsView } from "@/hooks/usePrismMarketsAndPortfolio";
import {
  carryProfitMusd,
  computeIcrBps,
  debtAtMaturity,
  formatBps,
  formatBtc,
  formatMusd,
  formatUsd,
  icrBand,
  liquidationPriceUsdWei,
  parseAmount,
  quotePtOut,
  secondsToMaturity,
  type IcrBand,
} from "@/lib/carry";

/**
 * Read-only Fixed Carry Spread Calculator (R-016, R-022): the user tunes
 * collateral, borrow size and series, and every figure is computed from live
 * on-chain numbers quoted with the block they were read at. No wallet, no
 * hardcoded APYs.
 */

const BAND_STYLES: Record<IcrBand, string> = {
  safe: "border-brand-cyan text-brand-cyan",
  caution: "border-brand-amber text-brand-amber",
  blocked: "border-red-500 text-red-400",
};

const BAND_LABELS: Record<IcrBand, string> = {
  safe: "Safe (>= 180%)",
  caution: "Caution (150%–179%)",
  blocked: "Blocked (< 150%)",
};

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-text-tertiary">
        {label}
      </span>
      {children}
      {hint ? <span className="text-[11px] text-text-tertiary">{hint}</span> : null}
    </label>
  );
}

function Metric({
  label,
  value,
  source,
  tone = "default",
}: {
  label: string;
  value: string;
  source?: string;
  tone?: "default" | "accent" | "warn";
}) {
  const toneClass =
    tone === "accent"
      ? "text-brand-cyan"
      : tone === "warn"
        ? "text-brand-amber"
        : "text-text-primary";
  return (
    <div className="flex flex-col gap-0.5" title={source}>
      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-tertiary">
        {label}
      </span>
      <span className={`font-mono text-sm tabular-nums ${toneClass}`}>{value}</span>
      {source ? (
        <span className="text-[10px] text-text-tertiary">{source}</span>
      ) : null}
    </div>
  );
}

export function FixedCarryCalculator({
  markets,
  blockNumber,
}: {
  markets?: MarketsView;
  blockNumber?: number;
}) {
  const [collateralInput, setCollateralInput] = useState("0.05");
  const [borrowInput, setBorrowInput] = useState("2000");
  const [selectedMaturity, setSelectedMaturity] = useState<number | undefined>();

  const series = markets?.series ?? [];
  const activeSeries =
    series.find((entry) => entry.maturityTimestamp === selectedMaturity) ?? series[0];

  const nowSeconds = Math.floor(Date.now() / 1000);
  const timeToMaturity = activeSeries
    ? secondsToMaturity(activeSeries.maturityTimestamp, nowSeconds)
    : 0n;

  const model = useMemo(() => {
    const collateral = parseAmount(collateralInput);
    const borrow = parseAmount(borrowInput);
    if (!markets || !activeSeries || borrow <= 0n || timeToMaturity <= 0n) {
      return undefined;
    }

    const price = parseAmount(markets.btcPriceUsd);
    const ptPrice = activeSeries.ptPriceWei ? BigInt(activeSeries.ptPriceWei) : 0n;
    if (ptPrice <= 0n) return undefined;

    const ptOut = quotePtOut(borrow, ptPrice);
    const owed = debtAtMaturity(borrow, markets.troveFixedBorrowAprBps, timeToMaturity);
    const profit = carryProfitMusd(
      borrow,
      ptPrice,
      activeSeries.fixedPtApyBps,
      markets.troveFixedBorrowAprBps,
      timeToMaturity,
    );
    const debtTotal = owed;
    const icr = computeIcrBps(collateral, debtTotal, price);
    const liquidation = liquidationPriceUsdWei(collateral, debtTotal);

    return {
      collateral,
      borrow,
      price,
      ptPrice,
      ptOut,
      owed,
      profit,
      icr,
      band: icrBand(icr),
      liquidation,
      spreadBps: activeSeries.netCarrySpreadBps,
    };
  }, [collateralInput, borrowInput, markets, activeSeries, timeToMaturity]);

  const blockSource = blockNumber ? `Mezo 31611 block #${blockNumber}` : "live chain read";
  const days = Number(timeToMaturity) / 86_400;

  return (
    <section
      aria-labelledby="calculator-heading"
      className="rounded-lg border border-border-default bg-bg-surface/60 p-4 sm:p-5"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2
          id="calculator-heading"
          className="font-mono text-[11px] uppercase tracking-[0.18em] text-text-secondary"
        >
          Fixed carry spread calculator
        </h2>
        <span
          className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-tertiary"
          title="Every figure below is read from these contracts at this block"
        >
          {blockSource} · AMM {markets ? "quoteBorrowAndLockSpread" : "…"} · TroveManager
        </span>
      </header>

      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <Field label="BTC collateral" hint="Locked in your Mezo Trove">
          <input
            inputMode="decimal"
            value={collateralInput}
            onChange={(event) => setCollateralInput(event.target.value)}
            className="rounded-md border border-border-default bg-bg-primary px-3 py-2 font-mono text-sm text-text-primary focus:border-brand-cyan focus:outline-none"
          />
        </Field>

        <Field
          label="MUSD to borrow"
          hint={
            markets
              ? `Min net debt 1,800 MUSD · Trove APR ${formatBps(markets.troveFixedBorrowAprBps)}`
              : undefined
          }
        >
          <input
            inputMode="decimal"
            value={borrowInput}
            onChange={(event) => setBorrowInput(event.target.value)}
            className="rounded-md border border-border-default bg-bg-primary px-3 py-2 font-mono text-sm text-text-primary focus:border-brand-cyan focus:outline-none"
          />
        </Field>

        <Field label="Maturity series" hint={days > 0 ? `${days.toFixed(1)} days to maturity` : undefined}>
          <select
            value={activeSeries?.maturityTimestamp ?? ""}
            onChange={(event) => setSelectedMaturity(Number(event.target.value))}
            className="rounded-md border border-border-default bg-bg-primary px-3 py-2 font-mono text-sm text-text-primary focus:border-brand-cyan focus:outline-none"
          >
            {series.map((entry) => (
              <option key={entry.maturityTimestamp} value={entry.maturityTimestamp}>
                {new Date(entry.maturityTimestamp * 1000).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </option>
            ))}
            {series.length === 0 ? <option value="">No active series</option> : null}
          </select>
        </Field>
      </div>

      {!markets ? (
        <p className="mt-4 text-xs text-text-tertiary">Loading live market data…</p>
      ) : !model ? (
        <p className="mt-4 text-xs text-brand-amber">
          Enter a borrow amount ({">="} 1,800 MUSD) and collateral to quote a lock.
        </p>
      ) : (
        <>
          <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Metric
              label="Trove borrow APR"
              value={formatBps(markets.troveFixedBorrowAprBps)}
              source="Mezo InterestRateManager"
            />
            <Metric
              label="PT-sMUSD fixed APY"
              value={formatBps(activeSeries!.fixedPtApyBps)}
              source="PrismYieldAMM quote"
            />
            <Metric
              label="Net guaranteed spread"
              value={formatBps(model.spreadBps)}
              tone={model.spreadBps > 0 ? "accent" : "warn"}
              source="fixed APY − borrow APR"
            />
            <Metric
              label="PT received today"
              value={`${formatMusd(model.ptOut, 4)} PT`}
              source={`price ${formatMusd(model.ptPrice, 6)} MUSD/PT`}
            />
          </dl>

          <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Metric
              label="Locked profit at maturity"
              value={`${formatMusd(model.profit, 4)} MUSD`}
              tone={model.profit > 0n ? "accent" : "warn"}
              source="PT par redemption − debt at maturity"
            />
            <Metric
              label="Debt at maturity"
              value={`${formatMusd(model.owed, 4)} MUSD`}
              source={`borrowed ${formatMusd(model.borrow, 2)} + interest`}
            />
            <Metric
              label="Post-borrow ICR"
              value={formatBps(model.icr)}
              tone={model.band === "blocked" ? "warn" : "default"}
              source="collateral × price ÷ debt"
            />
            <Metric
              label="Liquidation BTC price"
              value={`$${formatUsd(model.liquidation)}`}
              source="at Mezo MCR 110%"
            />
          </dl>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <span
              className={`rounded-full border px-3 py-1 font-mono text-[10px] uppercase tracking-[0.14em] ${BAND_STYLES[model.band]}`}
            >
              {BAND_LABELS[model.band]}
            </span>
            <span className="font-mono text-[11px] text-text-secondary">
              {formatBtc(model.collateral)} BTC collateral ·{" "}
              {formatMusd(model.borrow, 0)} MUSD borrowed
            </span>
          </div>

          {model.band === "blocked" ? (
            <p role="alert" className="mt-3 text-xs text-red-400">
              This lock would be rejected: PrismBorrowLockRouter requires a
              post-borrow ICR of at least 150% (currently {formatBps(model.icr)}).
              Add collateral or borrow less.
            </p>
          ) : null}

          {model.profit <= 0n ? (
            <p className="mt-3 text-xs text-brand-amber">
              At this size and maturity the fixed rate does not beat the borrow
              rate, so the carry is not positive.
            </p>
          ) : null}
        </>
      )}

      {activeSeries && activeSeries.fixedPtApyBps <= 0 && activeSeries.maturityTimestamp * 1000 < Date.now() ? (
        <p className="mt-3 text-xs text-text-tertiary">
          This series has matured; PT redeems at par and no new lock can be quoted.
        </p>
      ) : null}

    </section>
  );
}
