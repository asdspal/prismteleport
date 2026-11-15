"use client";

import { useState } from "react";
import { isAddress, type Address } from "viem";
import { usePrismMarketsAndPortfolio } from "@/hooks/usePrismMarketsAndPortfolio";
import { DEMO_BORROWER } from "@/providers/judgeMode";
import { formatBps, formatMusd } from "@/lib/carry";

/**
 * Paste-any-Trove inspector (R-016): anyone can inspect a Mezo borrower's live
 * health and see the fixed rate they could lock today, with no wallet and no
 * signature. Pre-filled with the Step 1.5 demo borrower.
 */

export function PasteAnyTroveInspector({ chainId = 31611 }: { chainId?: number }) {
  const [input, setInput] = useState<string>(DEMO_BORROWER);
  const [address, setAddress] = useState<Address | undefined>(DEMO_BORROWER);
  const [invalid, setInvalid] = useState(false);

  const { markets, portfolio, source, loading, error, blockNumber } =
    usePrismMarketsAndPortfolio(address, chainId);

  function inspect(value: string) {
    setInput(value);
    if (isAddress(value)) {
      setAddress(value as Address);
      setInvalid(false);
    } else {
      setInvalid(true);
      setAddress(undefined);
    }
  }

  return (
    <section
      aria-labelledby="inspector-heading"
      className="rounded-lg border border-border-default bg-bg-surface/60 p-4 sm:p-5"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2
          id="inspector-heading"
          className="font-mono text-[11px] uppercase tracking-[0.18em] text-text-secondary"
        >
          Inspect any Trove
        </h2>
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-tertiary">
          {source === "onchain" ? "direct on-chain RPC" : "indexed api"}
          {blockNumber ? ` @ block #${blockNumber}` : ""}
        </span>
      </header>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          value={input}
          onChange={(event) => inspect(event.target.value)}
          spellCheck={false}
          aria-label="Mezo borrower address"
          placeholder="0x… Mezo borrower address"
          className="min-w-0 flex-1 rounded-md border border-border-default bg-bg-primary px-3 py-2 font-mono text-xs text-text-primary focus:border-brand-cyan focus:outline-none"
        />
        <button
          type="button"
          onClick={() => inspect(DEMO_BORROWER)}
          className="rounded-md border border-border-default px-3 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-text-secondary transition-colors hover:text-text-primary"
        >
          Use demo borrower
        </button>
      </div>

      {invalid ? (
        <p role="alert" className="mt-3 text-xs text-brand-amber">
          That is not a valid 0x address.
        </p>
      ) : null}

      {error ? <p className="mt-3 text-xs text-brand-amber">{error}</p> : null}

      {!invalid && portfolio ? (
        <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-tertiary">
              Collateral
            </span>
            <span className="font-mono text-sm tabular-nums text-text-primary">
              {Number(portfolio.troveCollateralBtc).toFixed(4)} BTC
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-tertiary">
              Debt
            </span>
            <span className="font-mono text-sm tabular-nums text-text-primary">
              {Number(portfolio.troveDebtMusd).toLocaleString("en-US", {
                maximumFractionDigits: 2,
              })}{" "}
              MUSD
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-tertiary">
              ICR
            </span>
            <span className="font-mono text-sm tabular-nums text-text-primary">
              {portfolio.troveIcrBps > 0 ? formatBps(portfolio.troveIcrBps) : "—"}
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-tertiary">
              Best fixed rate today
            </span>
            <span className="font-mono text-sm tabular-nums text-brand-cyan">
              {markets && markets.series.length > 0
                ? formatBps(
                    Math.max(...markets.series.map((entry) => entry.fixedPtApyBps)),
                  )
                : "—"}
            </span>
          </div>
        </dl>
      ) : null}

      {!invalid && !portfolio && loading ? (
        <p className="mt-3 text-xs text-text-tertiary">Reading the Trove…</p>
      ) : null}

      {!invalid && portfolio && Number(portfolio.troveDebtMusd) === 0 ? (
        <p className="mt-3 text-xs text-text-tertiary">
          This address has no open Trove ({formatMusd(0n, 0)} MUSD debt) — nothing to
          inspect yet.
        </p>
      ) : null}
    </section>
  );
}
