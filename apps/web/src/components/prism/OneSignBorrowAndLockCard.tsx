"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPublicClient, http, type Address, type Hex, type PublicClient } from "viem";
import { useAccount, useSignTypedData } from "wagmi";
import { usePaddedWrite } from "@/hooks/usePaddedWrite";
import type { MarketsView, PortfolioView } from "@/hooks/usePrismMarketsAndPortfolio";
import { computeTroveHints } from "@prism-teleport/sdk";
import { apiBaseUrl } from "@/hooks/usePrismMarketsAndPortfolio";
import { mezoTestnet } from "@/lib/chains";
import {
  BORROWER_OPS_SIGNATURES_ABI,
  buildLockTermsTypedData,
  pickFreshRouterNonce,
  buildMezoWithdrawTypedData,
  buildRelayBody,
  EXPLORER_TX_URL,
  HINTS_GAS_SAVED,
  minOutWithSlippage,
  PRISM_ADDRESSES,
  ROUTER_ABI,
  validateBorrowAmount,
} from "@/lib/prismTerminal";
import { formatBps, formatMusd, parseAmount } from "@/lib/carry";

/**
 * One-signature Borrow & Lock (R-006, R-009, R-012, R-013): exact HintHelpers
 * hints, both EIP-712 signatures (Mezo `WithdrawMUSD` + Prism `LockTerms`), then
 * either the gasless relayer (`POST /v1/relay/borrow-and-lock`, zero BTC gas) or
 * a direct wallet transaction.
 */

type Mode = "gasless" | "direct";
type Status =
  | { kind: "idle" }
  | { kind: "hints"; message: string }
  | { kind: "signing"; message: string }
  | { kind: "submitted"; message: string; txHash?: string; relayId?: string }
  | { kind: "error"; message: string };

interface Hints {
  upperHint: Address;
  lowerHint: Address;
  source: "api" | "onchain";
}

export function OneSignBorrowAndLockCard({
  chainId = 31611,
  markets,
  portfolio,
  blockNumber,
  publicClient,
}: {
  chainId?: number;
  markets?: MarketsView;
  portfolio?: PortfolioView;
  blockNumber?: number;
  /** Injectable for tests; defaults to a browser client for the chain. */
  publicClient?: PublicClient;
}) {
  const { address, isConnected } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  const writeContractAsync = usePaddedWrite();

  const [borrowInput, setBorrowInput] = useState("2000");
  const [relayerFeeInput, setRelayerFeeInput] = useState("2");
  const [mode, setMode] = useState<Mode>("gasless");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [hints, setHints] = useState<Hints | undefined>();

  const addresses = PRISM_ADDRESSES[31611];
  const borrow = useMemo(() => parseAmount(borrowInput), [borrowInput]);
  const relayerFee = useMemo(() => parseAmount(relayerFeeInput), [relayerFeeInput]);
  const existingDebt = useMemo(
    () => (portfolio ? parseAmount(portfolio.troveDebtMusd) : 0n),
    [portfolio],
  );
  const collateral = useMemo(
    () => (portfolio ? parseAmount(portfolio.troveCollateralBtc) : 0n),
    [portfolio],
  );

  const series = markets?.series ?? [];
  const activeSeries = series[0];
  const validation = validateBorrowAmount(existingDebt, borrow);

  const ptPrice = activeSeries?.ptPriceWei ? BigInt(activeSeries.ptPriceWei) : 0n;
  const quotedPtOut =
    ptPrice > 0n && borrow > 0n ? (borrow * 10n ** 18n) / ptPrice : 0n;
  const minPtOut = quotedPtOut > 0n ? minOutWithSlippage(quotedPtOut) : 0n;

  const fetchHints = useCallback(async () => {
    if (!address || collateral <= 0n || borrow <= 0n) return;
    setStatus({ kind: "hints", message: "Looking up exact insertion hints…" });
    const totalDebt = existingDebt + borrow;
    try {
      const url = `${apiBaseUrl()}/v1/hints?chainId=${chainId}&collateralBtcWei=${collateral}&debtMusdWei=${totalDebt}`;
      const response = await fetch(url, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`hints API ${response.status}`);
      const body = (await response.json()) as { upperHint: Address; lowerHint: Address };
      setHints({ ...body, source: "api" });
      setStatus({
        kind: "hints",
        message: `Hints ready from /v1/hints · ${HINTS_GAS_SAVED}`,
      });
    } catch {
      // Browser fallback: same SDK the relayer uses (R-012).
      const client =
        publicClient ?? createPublicClient({ chain: mezoTestnet, transport: http() });
      const computed = await computeTroveHints(client, chainId, collateral, totalDebt);
      setHints({ ...computed, source: "onchain" });
      setStatus({
        kind: "hints",
        message: `Hints computed in-browser · ${HINTS_GAS_SAVED}`,
      });
    }
  }, [address, collateral, borrow, existingDebt, chainId, publicClient]);

  useEffect(() => {
    if (isConnected && !hints) void fetchHints();
  }, [isConnected, hints, fetchHints]);

  async function submit() {
    if (!address || !activeSeries || !hints) return;
    try {
      // Read both nonces and the chain timestamp immediately before signing, so a
      // stale nonce or deadline can never reach the wallet prompt (Step 3.3 risk).
      setStatus({ kind: "signing", message: "Reading live nonces and block time…" });
      const client =
        publicClient ?? createPublicClient({ chain: mezoTestnet, transport: http() });
      const [mezoNonce, prismNonce, block] = await Promise.all([
        // BorrowerOperationsSignatures exposes getNonce(address).
        client.readContract({
          address: addresses.borrowerOpsSignatures,
          abi: BORROWER_OPS_SIGNATURES_ABI,
          functionName: "getNonce",
          args: [address],
        }),
        // The router flags used nonces instead of counting them, so pick one.
        pickFreshRouterNonce(client, addresses.router, address),
        client.getBlock(),
      ]);
      const now = Number(block.timestamp);
      const deadline = BigInt(now + 3_600);
      const mezoDeadline = now + 3_600;
      const relayerFeeMusd = mode === "gasless" ? relayerFee : 0n;

      setStatus({ kind: "signing", message: "Sign the Mezo withdraw authorization…" });
      const mezoSignature = (await signTypedDataAsync(
        buildMezoWithdrawTypedData(chainId, addresses.borrowerOpsSignatures, {
          amount: borrow,
          borrower: address,
          recipient: addresses.router,
          nonce: mezoNonce,
          deadline,
        }),
      )) as Hex;

      setStatus({ kind: "signing", message: "Sign the Prism lock terms…" });
      const lockSignature = (await signTypedDataAsync(
        buildLockTermsTypedData(chainId, addresses.router, {
          borrower: address,
          musdBorrowAmount: borrow,
          maturity: BigInt(activeSeries.maturityTimestamp),
          minPtOut,
          relayerFeeMusd,
          nonce: prismNonce,
          deadline,
        }),
      )) as Hex;

      if (mode === "gasless") {
        setStatus({ kind: "submitted", message: "Submitting to the gasless relayer…" });
        const response = await fetch(`${apiBaseUrl()}/v1/relay/borrow-and-lock`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": crypto.randomUUID(),
          },
          body: JSON.stringify(
            buildRelayBody({
              chainId,
              borrower: address,
              musdBorrowAmount: borrow,
              maturity: activeSeries.maturityTimestamp,
              minPtOut,
              upperHint: hints.upperHint,
              lowerHint: hints.lowerHint,
              deadline: Number(deadline),
              prismSignature: lockSignature,
              mezoSignature,
              relayerFeeMusd,
              nonce: prismNonce,
              mezoDeadline,
            }),
          ),
        });
        const body = (await response.json()) as {
          relayId?: string;
          txHash?: string;
          status?: string;
          message?: string;
        };
        if (!response.ok) {
          setStatus({
            kind: "error",
            message: body.message ?? `Relayer rejected the request (${response.status})`,
          });
          return;
        }
        setStatus({
          kind: "submitted",
          message: `Relayed without spending BTC gas · ${body.status ?? "SUBMITTED"}`,
          txHash: body.txHash,
          relayId: body.relayId,
        });
        return;
      }

      setStatus({ kind: "submitted", message: "Sending the direct transaction…" });
      const hash = await writeContractAsync({
        address: addresses.router,
        abi: ROUTER_ABI,
        functionName: "borrowAndLockFixedYield",
        args: [
          {
            borrower: address,
            musdBorrowAmount: borrow,
            maturity: BigInt(activeSeries.maturityTimestamp),
            minPtOut,
            relayerFeeMusd,
            nonce: prismNonce,
            deadline,
            mezoDeadline: BigInt(mezoDeadline),
            upperHint: hints.upperHint,
            lowerHint: hints.lowerHint,
          },
          mezoSignature,
          lockSignature,
        ],
      });
      setStatus({ kind: "submitted", message: "Direct lock confirmed.", txHash: hash });
    } catch (error) {
      setStatus({
        kind: "error",
        message: error instanceof Error ? error.message : "The lock could not be submitted",
      });
    }
  }

  const canSubmit =
    isConnected && !!hints && !!activeSeries && validation.ok && minPtOut > 0n;

  return (
    <section
      aria-labelledby="onesign-heading"
      className="rounded-lg border border-border-default bg-bg-surface/60 p-4 sm:p-5"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2
          id="onesign-heading"
          className="font-mono text-[11px] uppercase tracking-[0.18em] text-text-secondary"
        >
          1-signature borrow &amp; lock
        </h2>
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-tertiary">
          PrismBorrowLockRouter{blockNumber ? ` @ block #${blockNumber}` : ""}
        </span>
      </header>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-text-tertiary">
            MUSD to borrow
          </span>
          <input
            inputMode="decimal"
            value={borrowInput}
            onChange={(event) => setBorrowInput(event.target.value)}
            className="rounded-md border border-border-default bg-bg-primary px-3 py-2 font-mono text-sm text-text-primary focus:border-brand-cyan focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-text-tertiary">
            Relayer fee (MUSD)
          </span>
          <input
            inputMode="decimal"
            value={relayerFeeInput}
            onChange={(event) => setRelayerFeeInput(event.target.value)}
            disabled={mode === "direct"}
            className="rounded-md border border-border-default bg-bg-primary px-3 py-2 font-mono text-sm text-text-primary focus:border-brand-cyan focus:outline-none disabled:opacity-50"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-text-tertiary">
            Series
          </span>
          <select
            disabled
            className="rounded-md border border-border-default bg-bg-primary px-3 py-2 font-mono text-sm text-text-primary disabled:opacity-70"
          >
            {activeSeries ? (
              <option>
                {new Date(activeSeries.maturityTimestamp * 1000).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </option>
            ) : (
              <option>No active series</option>
            )}
          </select>
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {(
          [
            { id: "gasless", label: "Gasless relayer · 0 BTC gas" },
            { id: "direct", label: "Direct wallet tx" },
          ] as const
        ).map((option) => (
          <button
            key={option.id}
            type="button"
            aria-pressed={mode === option.id}
            onClick={() => setMode(option.id)}
            className={`rounded-full border px-3 py-1 font-mono text-[10px] uppercase tracking-[0.14em] transition-colors ${
              mode === option.id
                ? "border-brand-cyan text-brand-cyan"
                : "border-border-default text-text-secondary hover:text-text-primary"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="flex flex-col gap-0.5">
          <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-tertiary">
            Fixed APY locked
          </dt>
          <dd className="font-mono text-sm tabular-nums text-brand-cyan">
            {activeSeries ? formatBps(activeSeries.fixedPtApyBps) : "—"}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-tertiary">
            PT out (1% slippage)
          </dt>
          <dd className="font-mono text-sm tabular-nums text-text-primary">
            {minPtOut > 0n ? `${formatMusd(minPtOut, 4)} PT` : "—"}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-tertiary">
            Trove ICR now
          </dt>
          <dd className="font-mono text-sm tabular-nums text-text-primary">
            {portfolio && portfolio.troveIcrBps > 0 ? formatBps(portfolio.troveIcrBps) : "—"}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-tertiary">
            Hints
          </dt>
          <dd className="font-mono text-[11px] text-text-secondary">
            {hints ? `${hints.source === "api" ? "API" : "in-browser"}` : "—"}
          </dd>
        </div>
      </dl>

      {!isConnected ? (
        <p className="mt-4 text-xs text-text-tertiary">
          Connect a wallet (or use the header&apos;s demo inspector) to sign a lock.
        </p>
      ) : null}

      {!validation.ok && validation.reason === "below-min-net-debt" ? (
        <div className="mt-4 rounded-md border border-brand-amber p-3">
          <p className="text-xs text-brand-amber">
            Mezo requires a {validation.minNetDebtMusd} MUSD minimum to open a new
            standalone Trove.
          </p>
          <button
            type="button"
            onClick={() => setBorrowInput(validation.minNetDebtMusd)}
            className="mt-2 rounded-md border border-brand-amber px-3 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-brand-amber"
          >
            Set to {validation.minNetDebtMusd} MUSD
          </button>
          <p className="mt-2 text-[11px] text-text-tertiary">
            Or use the shared Micro-Vault (Milestone 4) to borrow smaller amounts.
          </p>
        </div>
      ) : null}

      {status.kind !== "idle" ? (
        <p
          role={status.kind === "error" ? "alert" : "status"}
          className={`mt-4 text-xs ${
            status.kind === "error" ? "text-red-400" : "text-text-secondary"
          }`}
        >
          {status.message}
        </p>
      ) : null}

      {status.kind === "submitted" && status.txHash ? (
        <ol className="mt-3 flex flex-col gap-1 font-mono text-[11px] text-text-secondary">
          <li>1. Signatures verified · hints attached</li>
          <li>2. {mode === "gasless" ? "Relayer broadcast" : "Wallet broadcast"} accepted</li>
          <li>
            3.{" "}
            <a
              className="text-brand-cyan underline"
              href={EXPLORER_TX_URL(status.txHash)}
              target="_blank"
              rel="noreferrer"
            >
              Track on Mezo explorer ↗
            </a>
          </li>
        </ol>
      ) : null}

      <button
        type="button"
        disabled={!canSubmit}
        onClick={() => void submit()}
        className="mt-4 w-full rounded-md border border-brand-cyan px-4 py-2 font-mono text-[11px] uppercase tracking-[0.14em] text-brand-cyan transition-colors hover:bg-brand-cyan/10 disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto"
      >
        {mode === "gasless" ? "Sign once · relayer locks it" : "Sign once · send directly"}
      </button>
    </section>
  );
}
