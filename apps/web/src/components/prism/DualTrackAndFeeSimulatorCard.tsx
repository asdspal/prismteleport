"use client";

import { useState } from "react";
import { useAccount, useReadContracts } from "wagmi";
import { usePaddedWrite } from "@/hooks/usePaddedWrite";
import { mezoTestnet } from "@/lib/chains";
import {
  ADAPTER_ABI,
  adapterModeLabel,
  DEFAULT_FEE_SIMULATION_MUSD,
  FEE_INJECTOR_ABI,
  PRISM_ADDRESSES,
  SMUSD_ABI,
  smusdSpotRate,
  smoothedVsSpotBps,
  TOKENIZER_ABI,
} from "@/lib/prismTerminal";
import { formatBps, formatMusd } from "@/lib/carry";

/**
 * Dual-track sMUSD regime monitor and testnet fee simulator (R-004, R-014,
 * GAP-001): the adapter's live mode, the smoothed vs spot sMUSD rate, and two
 * clearly-labelled testnet-only buttons (fee injection and a permissionless
 * dual-track rebalance).
 */

export function DualTrackAndFeeSimulatorCard() {
  const { isConnected } = useAccount();
  const writeContractAsync = usePaddedWrite();
  const [message, setMessage] = useState<string | undefined>();
  const injectAmount = DEFAULT_FEE_SIMULATION_MUSD;

  const addresses = PRISM_ADDRESSES[31611];

  const { data, refetch } = useReadContracts({
    contracts: [
      { address: addresses.adapter, abi: ADAPTER_ABI, functionName: "activeMode" },
      { address: addresses.adapter, abi: ADAPTER_ABI, functionName: "unstakedFeeAprBps" },
      { address: addresses.adapter, abi: ADAPTER_ABI, functionName: "gaugeMezoAprBps" },
      { address: addresses.adapter, abi: ADAPTER_ABI, functionName: "totalSmusdControlled" },
      { address: addresses.smusd, abi: SMUSD_ABI, functionName: "yieldIndex" },
      { address: addresses.tokenizer, abi: TOKENIZER_ABI, functionName: "smoothedExchangeRate" },
      { address: addresses.adapter, abi: ADAPTER_ABI, functionName: "SWITCH_HYSTERESIS_BPS" },
    ],
    query: { enabled: true },
  });

  const [modeRaw, unstakedApr, gaugeApr, totalControlled, yieldIndex, smoothedRate, hysteresis] =
    (data ?? []).map((entry) => entry?.result) as [
      bigint | undefined,
      bigint | undefined,
      bigint | undefined,
      bigint | undefined,
      bigint | undefined,
      bigint | undefined,
      bigint | undefined,
    ];

  const mode = modeRaw === undefined ? undefined : adapterModeLabel(modeRaw);
  const spotRate = yieldIndex === undefined ? undefined : smusdSpotRate(yieldIndex);

  async function simulateFeeYield() {
    try {
      setMessage("Approving MUSD for the testnet injector…");
      await writeContractAsync({
        address: addresses.musd,
        abi: SMUSD_ABI,
        functionName: "approve",
        args: [addresses.feeInjector, injectAmount],
      });
      setMessage("Injecting weekly sMUSD fee yield…");
      const hash = await writeContractAsync({
        address: addresses.feeInjector,
        abi: FEE_INJECTOR_ABI,
        functionName: "injectWeeklyFeeYield",
        args: [injectAmount],
      });
      setMessage(`Fee yield injected (${hash.slice(0, 12)}…) — smoothed rate now vests linearly.`);
      await refetch();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Fee injection failed");
    }
  }

  async function rebalance() {
    try {
      setMessage("Evaluating dual-track mode…");
      const hash = await writeContractAsync({
        address: addresses.adapter,
        abi: ADAPTER_ABI,
        functionName: "evaluateAndSwitchMode",
        args: [],
      });
      setMessage(`Rebalance submitted (${hash.slice(0, 12)}…)`);
      await refetch();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Rebalance failed");
    }
  }

  return (
    <section
      aria-labelledby="dualtrack-heading"
      className="rounded-lg border border-border-default bg-bg-surface/60 p-4 sm:p-5"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2
          id="dualtrack-heading"
          className="font-mono text-[11px] uppercase tracking-[0.18em] text-text-secondary"
        >
          Dual-track sMUSD monitor
        </h2>
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-tertiary">
          DualTrackAdapter {mezoTestnet.name}
        </span>
      </header>

      <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="flex flex-col gap-0.5">
          <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-tertiary">
            Active mode
          </dt>
          <dd className="font-mono text-sm text-brand-cyan">{mode ?? "—"}</dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-tertiary">
            Unstaked sMUSD APR
          </dt>
          <dd className="font-mono text-sm tabular-nums text-text-primary">
            {unstakedApr !== undefined ? formatBps(unstakedApr) : "—"}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-tertiary">
            Gauge MEZO APR
          </dt>
          <dd className="font-mono text-sm tabular-nums text-text-primary">
            {gaugeApr !== undefined ? formatBps(gaugeApr) : "—"}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-tertiary">
            sMUSD spot rate
          </dt>
          <dd className="font-mono text-sm tabular-nums text-text-primary">
            {spotRate !== undefined ? formatMusd(spotRate, 6) : "—"}
          </dd>
          <dd className="text-[10px] text-text-tertiary">
            smoothed {smoothedRate !== undefined ? formatMusd(smoothedRate, 6) : "—"}
            {hysteresis !== undefined ? ` · hysteresis ${formatBps(hysteresis)}` : ""}
          </dd>
        </div>
      </dl>

      <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
        <div className="flex flex-col gap-0.5">
          <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-tertiary">
            Smoothed vs spot
          </dt>
          <dd className="font-mono text-sm tabular-nums text-text-primary">
            {spotRate !== undefined && smoothedRate !== undefined
              ? `${smoothedVsSpotBps(smoothedRate, spotRate).toFixed(2)} bps`
              : "—"}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-tertiary">
            sMUSD under management
          </dt>
          <dd className="font-mono text-sm tabular-nums text-text-primary">
            {totalControlled !== undefined ? `${formatMusd(totalControlled, 2)} sMUSD` : "—"}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-tertiary">
            Yield index
          </dt>
          <dd className="font-mono text-sm tabular-nums text-text-primary">
            {yieldIndex !== undefined ? formatMusd(yieldIndex, 6) : "—"}
          </dd>
        </div>
      </dl>

      <p className="mt-4 text-[11px] text-text-secondary">
        Smoothed rates vest linearly after each fee drop, so a sandwich cannot
        capture the jump (STRIDE-02).
      </p>

      {message ? (
        <p role="status" className="mt-3 text-xs text-text-secondary">
          {message}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!isConnected}
          onClick={() => void simulateFeeYield()}
          className="rounded-md border border-brand-amber px-4 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-brand-amber transition-colors hover:bg-brand-amber/10 disabled:cursor-not-allowed disabled:opacity-40"
        >
          [TESTNET SIMULATOR] Weekly sMUSD fee drop (+{formatMusd(injectAmount, 0)} MUSD)
        </button>
        <button
          type="button"
          disabled={!isConnected}
          onClick={() => void rebalance()}
          className="rounded-md border border-border-default px-4 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-text-secondary transition-colors hover:text-text-primary disabled:opacity-40"
        >
          Trigger permissionless dual-track rebalance
        </button>
      </div>
    </section>
  );
}
