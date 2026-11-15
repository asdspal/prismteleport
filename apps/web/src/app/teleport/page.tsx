"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { usePaddedWrite } from "@/hooks/usePaddedWrite";
import {
  buildTeleportRequest,
  MIN_TROVE_DEBT_MUSD,
  resolveIntentType,
  type TeleportIntentType,
  type TeleportIntentReceipt,
} from "@prism-teleport/sdk/PrismTeleportModal";
import { apiBaseUrl } from "@/hooks/usePrismMarketsAndPortfolio";
import { MEZO_TESTNET_TELEPORT_HUB, TELEPORT_HUB_ABI } from "@/lib/prismTerminal";
import { formatMusd, parseAmount } from "@/lib/carry";

/**
 * `/teleport` (R-007, R-008, R-011, R-018, R-021): choose an origin and a
 * destination action, follow the three-step cross-chain receipt, and claim the
 * rescue escrow if the Mezo leg had to be caught (STRIDE-05).
 */

const ORIGINS = [
  { id: 84532, label: "Base Sepolia 84532", note: "Cross-chain teleport" },
  { id: 31611, label: "Mezo Direct 31611", note: "Gasless 1-tx, no bridge latency" },
] as const;

const DESTINATIONS: Array<{ id: TeleportIntentType; label: string }> = [
  { id: "BORROW_AND_LOCK_PT", label: "Lock fixed yield in PT-sMUSD" },
  { id: "BORROW_AND_TELEPORT_MUSD", label: "Receive MUSD on Base via Wormhole NTT" },
  { id: "MICRO_TELEPORT", label: "Micro-borrow (< 1,800 MUSD)" },
  { id: "REPAY_AND_CLOSE", label: "Repay & close from Base" },
];

interface StatusRow {
  intentHash: string;
  status: string;
  mezoTxHash?: string;
  sourceTxHash?: string;
  message?: string;
}

const STEPS = [
  { key: "PENDING_SOURCE", label: "Source transaction" },
  { key: "EXECUTING_MEZO", label: "Mezo TeleportHub" },
  { key: "COMPLETED", label: "Receipt" },
] as const;

export default function TeleportPage() {
  const { address, isConnected } = useAccount();
  const writeContractAsync = usePaddedWrite();

  const [origin, setOrigin] = useState<number>(84532);
  const [destination, setDestination] = useState<TeleportIntentType>("BORROW_AND_LOCK_PT");
  const [borrowInput, setBorrowInput] = useState("2000");
  const [collateralInput, setCollateralInput] = useState("0.05");
  const [intentHash, setIntentHash] = useState<string | undefined>();
  const [status, setStatus] = useState<StatusRow | undefined>();
  const [message, setMessage] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const effectiveType = useMemo(
    () => resolveIntentType(destination, borrowInput, MIN_TROVE_DEBT_MUSD),
    [destination, borrowInput],
  );
  const isMicro = effectiveType === "MICRO_TELEPORT";

  // Poll the intent so the stepper advances without a manual refresh.
  const poll = useCallback(async () => {
    if (!intentHash) return;
    try {
      const response = await fetch(`${apiBaseUrl()}/v1/teleport/intent/${intentHash}`);
      if (response.ok) setStatus((await response.json()) as StatusRow);
    } catch {
      // Polling is best-effort; the UI keeps the last known status.
    }
  }, [intentHash]);

  useEffect(() => {
    if (!intentHash) return;
    void poll();
    const timer = setInterval(() => void poll(), 4_000);
    return () => clearInterval(timer);
  }, [intentHash, poll]);

  async function submit() {
    setBusy(true);
    setMessage("Signing the intent and asking the relayer to execute on Mezo…");
    try {
      const request = buildTeleportRequest({
        sourceChainId: origin,
        userAddress: address ?? "0x0000000000000000000000000000000000000000",
        intentType: effectiveType,
        collateralBtc: collateralInput,
        borrowMusd: borrowInput,
        eip712Signature: "0x",
        seriesMaturity: undefined,
        minTroveDebtMusd: MIN_TROVE_DEBT_MUSD,
      });
      const response = await fetch(`${apiBaseUrl()}/v1/teleport/intent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      const body = (await response.json()) as TeleportIntentReceipt & { message?: string };
      if (!response.ok) throw new Error(body.message ?? `relayer responded ${response.status}`);
      setIntentHash(body.intentHash);
      setStatus(body as StatusRow);
      setMessage(`Intent accepted · ${body.status}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "the teleport could not be submitted");
    } finally {
      setBusy(false);
    }
  }

  async function claimRescue() {
    try {
      setMessage("Claiming the rescue escrow…");
      const hash = await writeContractAsync({
        address: MEZO_TESTNET_TELEPORT_HUB,
        abi: TELEPORT_HUB_ABI,
        functionName: "withdrawRescueBtc",
        args: [],
      } as never);
      setMessage(`Rescue withdrawn (${String(hash).slice(0, 12)}…)`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "the rescue claim failed");
    }
  }

  const currentIndex = status
    ? STEPS.findIndex((step) => step.key === status.status)
    : -1;
  const rescued = status?.status === "RESCUED_ESCROW";

  return (
    <main id="main" className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
      <header>
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-brand-cyan">
          Cross-chain teleport
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-text-primary sm:text-3xl">
          Borrow on Mezo from Base.
        </h1>
        <p className="mt-3 max-w-3xl text-sm text-text-secondary">
          One signed intent opens the Trove in your own address on Mezo — or routes
          through the shared micro vault under {MIN_TROVE_DEBT_MUSD} MUSD — and sends
          the fixed-yield PT (or MUSD back to Base) straight to you. The hub never
          holds your funds: if the Mezo leg has to be caught mid-flight, 100% of the
          BTC is credited to your rescue escrow.
        </p>
      </header>

      <section
        aria-labelledby="teleport-form-heading"
        className="mt-6 rounded-lg border border-border-default bg-bg-surface/60 p-4 sm:p-5"
      >
        <h2
          id="teleport-form-heading"
          className="font-mono text-[11px] uppercase tracking-[0.18em] text-text-secondary"
        >
          Origin &amp; destination
        </h2>

        <fieldset className="mt-4">
          <legend className="font-mono text-[10px] uppercase tracking-[0.16em] text-text-tertiary">
            Origin
          </legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {ORIGINS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                aria-pressed={origin === entry.id}
                onClick={() => setOrigin(entry.id)}
                className={`rounded-full border px-3 py-1 font-mono text-[10px] uppercase tracking-[0.14em] transition-colors ${
                  origin === entry.id
                    ? "border-brand-cyan text-brand-cyan"
                    : "border-border-default text-text-secondary hover:text-text-primary"
                }`}
              >
                {entry.label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-text-tertiary">
            {ORIGINS.find((entry) => entry.id === origin)?.note}
          </p>
        </fieldset>

        <label className="mt-4 flex flex-col gap-1 sm:max-w-md">
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-text-tertiary">
            Destination action
          </span>
          <select
            value={destination}
            onChange={(event) => setDestination(event.target.value as TeleportIntentType)}
            className="rounded-md border border-border-default bg-bg-primary px-3 py-2 font-mono text-sm text-text-primary focus:border-brand-cyan focus:outline-none"
          >
            {DESTINATIONS.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-text-tertiary">
              BTC collateral
            </span>
            <input
              inputMode="decimal"
              value={collateralInput}
              onChange={(event) => setCollateralInput(event.target.value)}
              className="rounded-md border border-border-default bg-bg-primary px-3 py-2 font-mono text-sm text-text-primary focus:border-brand-cyan focus:outline-none"
            />
          </label>
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
        </div>

        <p className="mt-3 text-[11px] text-text-secondary">
          {isMicro
            ? `Under ${MIN_TROVE_DEBT_MUSD} MUSD → routed through the shared micro vault (R-011), position held in your name.`
            : "Standalone Trove opened in your own address via TeleportHub."}
        </p>
        {isMicro ? (
          <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.14em] text-brand-amber">
            Micro-vault path selected
          </p>
        ) : null}

        {message ? (
          <p role="status" className="mt-3 text-xs text-text-secondary">
            {message}
          </p>
        ) : null}

        {!isConnected ? (
          <p className="mt-3 text-xs text-text-tertiary">
            Connect a wallet to sign an intent; the stepper below stays readable either
            way.
          </p>
        ) : null}

        <button
          type="button"
          disabled={busy || parseAmount(borrowInput) <= 0n}
          onClick={() => void submit()}
          className="mt-4 rounded-md border border-brand-cyan px-4 py-2 font-mono text-[11px] uppercase tracking-[0.14em] text-brand-cyan transition-colors hover:bg-brand-cyan/10 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "Submitting…" : "Sign intent & teleport"}
        </button>
      </section>

      <section
        aria-labelledby="teleport-stepper-heading"
        className="mt-5 rounded-lg border border-border-default bg-bg-surface/60 p-4 sm:p-5"
      >
        <h2
          id="teleport-stepper-heading"
          className="font-mono text-[11px] uppercase tracking-[0.18em] text-text-secondary"
        >
          Cross-chain receipt
        </h2>

        <ol className="mt-4 grid gap-3 sm:grid-cols-3">
          {STEPS.map((step, index) => {
            const done = currentIndex >= index || status?.status === "COMPLETED";
            return (
              <li
                key={step.key}
                aria-current={currentIndex === index ? "step" : undefined}
                className={`rounded-md border p-3 ${
                  done ? "border-brand-cyan" : "border-border-default"
                }`}
              >
                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-tertiary">
                  Step {index + 1}
                </p>
                <p className="mt-1 font-mono text-xs text-text-primary">{step.label}</p>
                <p className="mt-1 text-[11px] text-text-secondary">
                  {done ? "Confirmed" : currentIndex === index ? "In progress" : "Waiting"}
                </p>
              </li>
            );
          })}
        </ol>

        {status ? (
          <dl className="mt-4 grid gap-2 font-mono text-[11px] text-text-secondary">
            <div>
              <dt className="inline text-text-tertiary">intentHash </dt>
              <dd className="inline">{status.intentHash}</dd>
            </div>
            {status.sourceTxHash ? (
              <div>
                <dt className="inline text-text-tertiary">source tx </dt>
                <dd className="inline">{status.sourceTxHash}</dd>
              </div>
            ) : null}
            {status.mezoTxHash ? (
              <div>
                <dt className="inline text-text-tertiary">Mezo tx </dt>
                <dd className="inline">
                  <a
                    className="text-brand-cyan underline"
                    href={`https://explorer.test.mezo.org/tx/${status.mezoTxHash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {status.mezoTxHash.slice(0, 18)}… ↗
                  </a>
                </dd>
              </div>
            ) : null}
            <div>
              <dt className="inline text-text-tertiary">status </dt>
              <dd className="inline">{status.status}</dd>
            </div>
          </dl>
        ) : (
          <p className="mt-3 text-xs text-text-tertiary">
            Submit an intent to follow it from the source transaction to the Mezo
            receipt.
          </p>
        )}

        {rescued ? (
          <div className="mt-4 rounded-md border border-brand-amber p-3">
            <p role="alert" className="text-xs text-brand-amber">
              The Mezo leg could not complete, so 100% of your BTC is held in the
              rescue escrow. Nothing is lost — withdraw it any time.
            </p>
            <button
              type="button"
              disabled={!isConnected}
              onClick={() => void claimRescue()}
              className="mt-2 rounded-md border border-brand-amber px-3 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-brand-amber disabled:opacity-40"
            >
              Claim rescue BTC
            </button>
          </div>
        ) : null}

        <p className="mt-4 text-[11px] text-text-tertiary">
          Collateral escrowed: {formatMusd(parseAmount(collateralInput), 4)} BTC · borrow{" "}
          {formatMusd(parseAmount(borrowInput), 2)} MUSD
        </p>
      </section>
    </main>
  );
}
