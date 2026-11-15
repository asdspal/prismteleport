"use client";

import { useMemo, useState } from "react";
import { useAccount, useWriteContract } from "wagmi";
import type { MarketsView, PortfolioView } from "@/hooks/usePrismMarketsAndPortfolio";
import { AMM_ABI, PRISM_ADDRESSES, TOKENIZER_ABI, ERC20_ABI, minOutWithSlippage } from "@/lib/prismTerminal";
import { formatBps, formatMusd, parseAmount, quotePtOut, WAD } from "@/lib/carry";

/**
 * PT / YT mint, swap and redeem (R-001, R-002, R-003, R-005): fixed-rate PT buys,
 * YT yield-leverage buys with the flash-mint netting preview, plus mint, early
 * redeem, matured redeem and yield claiming.
 */

type Tab = "pt" | "yt" | "mint";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "pt", label: "Buy PT-sMUSD (fixed)" },
  { id: "yt", label: "Buy YT-sMUSD (leverage)" },
  { id: "mint", label: "Mint / Redeem / Claim" },
];

export function PtYtSwapAndMintCard({
  markets,
  portfolio,
  blockNumber,
}: {
  markets?: MarketsView;
  portfolio?: PortfolioView;
  blockNumber?: number;
}) {
  const { isConnected } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const [tab, setTab] = useState<Tab>("pt");
  const [amountInput, setAmountInput] = useState("100");
  const [message, setMessage] = useState<string | undefined>();

  const addresses = PRISM_ADDRESSES[31611];
  const amount = useMemo(() => parseAmount(amountInput), [amountInput]);
  const series = markets?.series ?? [];
  const activeSeries = series[0];
  const maturity = activeSeries?.maturityTimestamp;
  const ptPrice = activeSeries?.ptPriceWei ? BigInt(activeSeries.ptPriceWei) : 0n;

  // Fixed-rate preview: exactly what PrismYieldAMM.swapExactMusdForPt returns.
  const ptOut = ptPrice > 0n ? quotePtOut(amount, ptPrice) : 0n;

  // Yield-leverage preview: previewSwapMusdForYt nets the PT leg back as MUSD.
  const ytPreview = useMemo(() => {
    if (ptPrice <= 0n || amount <= 0n) return undefined;
    const ytOut = (amount * 9_995n) / 10_000n; // amount - 5 bps fee
    const refundMusd = (ytOut * ptPrice) / WAD;
    const netCost = amount - refundMusd;
    const leverage = netCost > 0n ? Number((ytOut * 100n) / netCost) / 100 : 0;
    return { ytOut, refundMusd, netCost, leverage };
  }, [amount, ptPrice]);

  async function send(
    functionName: "swapExactMusdForPt" | "swapExactMusdForYt" | "mintPyFromMusd" | "redeemPyBeforeMaturity" | "redeemPtAfterMaturity" | "claimYield",
  ) {
    if (!maturity) return;
    try {
      setMessage("Waiting for wallet confirmation…");
      const minOut = minOutWithSlippage(
        functionName === "swapExactMusdForYt" ? (ytPreview?.ytOut ?? 0n) : ptOut,
      );

      if (functionName === "mintPyFromMusd") {
        const hash = await writeContractAsync({
          address: addresses.musd,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [addresses.tokenizer, amount],
        });
        setMessage(`MUSD approved (${hash.slice(0, 10)}…) — minting PT + YT…`);
      }

      const hash = await writeContractAsync({
        address:
          functionName === "mintPyFromMusd" ||
          functionName === "redeemPyBeforeMaturity" ||
          functionName === "redeemPtAfterMaturity" ||
          functionName === "claimYield"
            ? addresses.tokenizer
            : addresses.amm,
        abi: functionName === "mintPyFromMusd" || functionName === "claimYield" ? TOKENIZER_ABI : AMM_ABI,
        functionName: functionName as never,
        args:
          functionName === "swapExactMusdForPt"
            ? [BigInt(maturity), amount, minOut, addresses.amm]
            : functionName === "swapExactMusdForYt"
              ? [BigInt(maturity), amount, minOut, addresses.amm]
              : [amount, BigInt(maturity), addresses.tokenizer],
      } as never);
      setMessage(`Submitted ${hash.slice(0, 12)}…`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Transaction failed");
    }
  }

  return (
    <section
      aria-labelledby="ptytswap-heading"
      className="rounded-lg border border-border-default bg-bg-surface/60 p-4 sm:p-5"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2
          id="ptytswap-heading"
          className="font-mono text-[11px] uppercase tracking-[0.18em] text-text-secondary"
        >
          PT / YT swap &amp; mint
        </h2>
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-tertiary">
          PrismYieldAMM + PrismTokenizer{blockNumber ? ` @ block #${blockNumber}` : ""}
        </span>
      </header>

      <div className="mt-4 flex flex-wrap gap-2">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            aria-pressed={tab === entry.id}
            onClick={() => setTab(entry.id)}
            className={`rounded-full border px-3 py-1 font-mono text-[10px] uppercase tracking-[0.14em] transition-colors ${
              tab === entry.id
                ? "border-brand-cyan text-brand-cyan"
                : "border-border-default text-text-secondary hover:text-text-primary"
            }`}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <label className="mt-4 flex flex-col gap-1">
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-text-tertiary">
          MUSD amount
        </span>
        <input
          inputMode="decimal"
          value={amountInput}
          onChange={(event) => setAmountInput(event.target.value)}
          className="rounded-md border border-border-default bg-bg-primary px-3 py-2 font-mono text-sm text-text-primary focus:border-brand-cyan focus:outline-none"
        />
      </label>

      <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="flex flex-col gap-0.5">
          <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-tertiary">
            {tab === "yt" ? "YT out (est.)" : "PT out (est.)"}
          </dt>
          <dd className="font-mono text-sm tabular-nums text-text-primary">
            {tab === "yt"
              ? ytPreview
                ? `${formatMusd(ytPreview.ytOut, 4)} YT`
                : "—"
              : ptOut > 0n
                ? `${formatMusd(ptOut, 4)} PT`
                : "—"}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-tertiary">
            Fixed APY / implied
          </dt>
          <dd className="font-mono text-sm tabular-nums text-brand-cyan">
            {activeSeries
              ? `${formatBps(activeSeries.fixedPtApyBps)} / ${formatBps(activeSeries.impliedYtApyBps)}`
              : "—"}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-tertiary">
            {tab === "yt" ? "Net cost after netting" : "PT price"}
          </dt>
          <dd className="font-mono text-sm tabular-nums text-text-primary">
            {tab === "yt"
              ? ytPreview
                ? `${formatMusd(ytPreview.netCost, 4)} MUSD`
                : "—"
              : ptPrice > 0n
                ? formatMusd(ptPrice, 6)
                : "—"}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-tertiary">
            Yield leverage
          </dt>
          <dd className="font-mono text-sm tabular-nums text-text-primary">
            {tab === "yt" && ytPreview ? `${ytPreview.leverage.toFixed(2)}x` : "—"}
          </dd>
        </div>
      </dl>

      {tab === "yt" && ytPreview ? (
        <p className="mt-3 text-[11px] text-text-secondary">
          Flash-mint netting: {formatMusd(ytPreview.ytOut, 2)} YT keeps its full
          notional while only {formatMusd(ytPreview.netCost, 2)} MUSD stays at risk
          ({ytPreview.leverage.toFixed(2)}x exposure to sMUSD + MEZO gauge yield).
        </p>
      ) : null}

      {tab === "mint" && portfolio ? (
        <p className="mt-3 font-mono text-[11px] text-text-secondary">
          Held: {formatMusd(parseAmount(portfolio.ptBalance), 4)} PT ·{" "}
          {formatMusd(parseAmount(portfolio.ytBalance), 4)} YT
        </p>
      ) : null}

      {!isConnected ? (
        <p className="mt-3 text-xs text-text-tertiary">
          Connect a wallet to swap, mint, redeem or claim.
        </p>
      ) : null}

      {message ? (
        <p role="status" className="mt-3 text-xs text-text-secondary">
          {message}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        {tab === "pt" ? (
          <button
            type="button"
            disabled={!isConnected || ptOut <= 0n}
            onClick={() => void send("swapExactMusdForPt")}
            className="rounded-md border border-brand-cyan px-4 py-2 font-mono text-[11px] uppercase tracking-[0.14em] text-brand-cyan transition-colors hover:bg-brand-cyan/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Swap MUSD → PT
          </button>
        ) : null}

        {tab === "yt" ? (
          <button
            type="button"
            disabled={!isConnected || !ytPreview}
            onClick={() => void send("swapExactMusdForYt")}
            className="rounded-md border border-brand-cyan px-4 py-2 font-mono text-[11px] uppercase tracking-[0.14em] text-brand-cyan transition-colors hover:bg-brand-cyan/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Swap MUSD → YT (leveraged)
          </button>
        ) : null}

        {tab === "mint" ? (
          <>
            <button
              type="button"
              disabled={!isConnected || amount <= 0n}
              onClick={() => void send("mintPyFromMusd")}
              className="rounded-md border border-border-default px-4 py-2 font-mono text-[11px] uppercase tracking-[0.14em] text-text-secondary transition-colors hover:text-text-primary disabled:opacity-40"
            >
              Mint PT + YT
            </button>
            <button
              type="button"
              disabled={!isConnected || amount <= 0n}
              onClick={() => void send("redeemPyBeforeMaturity")}
              className="rounded-md border border-border-default px-4 py-2 font-mono text-[11px] uppercase tracking-[0.14em] text-text-secondary transition-colors hover:text-text-primary disabled:opacity-40"
            >
              Redeem PT + YT early
            </button>
            <button
              type="button"
              disabled={!isConnected || amount <= 0n}
              onClick={() => void send("redeemPtAfterMaturity")}
              className="rounded-md border border-border-default px-4 py-2 font-mono text-[11px] uppercase tracking-[0.14em] text-text-secondary transition-colors hover:text-text-primary disabled:opacity-40"
            >
              Redeem matured PT 1:1
            </button>
            <button
              type="button"
              disabled={!isConnected}
              onClick={() => void send("claimYield")}
              className="rounded-md border border-brand-cyan px-4 py-2 font-mono text-[11px] uppercase tracking-[0.14em] text-brand-cyan transition-colors hover:bg-brand-cyan/10 disabled:opacity-40"
            >
              Claim YT yield (MUSD + MEZO)
            </button>
          </>
        ) : null}
      </div>
    </section>
  );
}
