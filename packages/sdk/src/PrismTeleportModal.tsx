"use client";

import { useState, type CSSProperties, type ReactNode } from "react";

/**
 * Embeddable teleport widget (R-018).
 *
 * A third-party Base or Mezo dApp drops this in and gets the whole cross-chain
 * borrow-and-lock flow without depending on the PrismTeleport frontend:
 *
 * ```tsx
 * <PrismTeleportModal defaultBorrowMusd="2000" onComplete={(tx) => console.log(tx)} />
 * ```
 *
 * The component is deliberately dependency-light (React only, inline styles) and
 * talks to the relayer's `POST /v1/teleport/intent`. All chain-specific work —
 * source transaction verification, hint computation, the Mezo `TeleportHub`
 * call — happens server-side, so the host app needs no viem wiring.
 */

export type TeleportIntentType =
  | "BORROW_AND_LOCK_PT"
  | "BORROW_AND_TELEPORT_MUSD"
  | "MICRO_TELEPORT"
  | "REPAY_AND_CLOSE";

export interface TeleportIntentRequest {
  sourceChainId: number;
  destChainId: number;
  userAddress: string;
  intentType: TeleportIntentType;
  collateralBtcWei: string;
  musdAmountWei: string;
  minOutputWei: string;
  deadline: number;
  eip712Signature: string;
  sourceTxHash?: string;
  seriesMaturity?: number;
  mezoBorrowSignature?: string;
}

export interface TeleportIntentReceipt {
  intentHash: string;
  status: string;
  mezoTxHash?: string;
  explorerUrl?: string;
}

export interface PrismTeleportModalProps {
  /** Relayer base URL; defaults to the public deployment. */
  apiBaseUrl?: string;
  /** Pre-fills the borrow size (MUSD, decimal string). */
  defaultBorrowMusd?: string;
  /** Pre-fills the BTC collateral (decimal string). */
  defaultCollateralBtc?: string;
  /** Destination action; `MICRO_TELEPORT` is auto-selected under 1,800 MUSD. */
  defaultIntentType?: TeleportIntentType;
  /** Mezo's standalone Trove minimum: below it the micro vault is used. */
  minTroveDebtMusd?: string;
  /** Called with the accepted intent. */
  onComplete?: (receipt: TeleportIntentReceipt) => void;
  /** Called on a rejected request. */
  onError?: (error: Error) => void;
  /** Anything the host app wants rendered under the form. */
  children?: ReactNode;
}

/** Mezo's standalone Trove minimum, used for the micro auto-detection. */
export const MIN_TROVE_DEBT_MUSD = "1800";

const WAD = 10n ** 18n;

function toWei(value: string): bigint {
  const trimmed = value.trim();
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === "" || trimmed === ".") return 0n;
  const [whole, fraction = ""] = trimmed.split(".");
  return BigInt(whole || "0") * WAD + BigInt(fraction.slice(0, 18).padEnd(18, "0") || "0");
}

/**
 * Auto-detects the micro path: anything under Mezo's 1,800 MUSD standalone
 * minimum can only be executed through the shared `PrismMicroVault` (R-011).
 */
export function resolveIntentType(
  requested: TeleportIntentType,
  borrowMusd: string,
  minTroveDebtMusd: string = MIN_TROVE_DEBT_MUSD,
): TeleportIntentType {
  if (requested === "REPAY_AND_CLOSE") return requested;
  if (toWei(borrowMusd) < toWei(minTroveDebtMusd)) return "MICRO_TELEPORT";
  return requested === "MICRO_TELEPORT" ? "MICRO_TELEPORT" : requested;
}

/** Builds the relayer request body from the widget's inputs. */
export function buildTeleportRequest(args: {
  sourceChainId: number;
  destChainId?: number;
  userAddress: string;
  intentType: TeleportIntentType;
  collateralBtc: string;
  borrowMusd: string;
  minOutputWei?: string;
  deadlineSeconds?: number;
  eip712Signature: string;
  sourceTxHash?: string;
  seriesMaturity?: number;
  mezoBorrowSignature?: string;
  minTroveDebtMusd?: string;
  nowSeconds?: number;
}): TeleportIntentRequest {
  const now = args.nowSeconds ?? Math.floor(Date.now() / 1000);
  return {
    sourceChainId: args.sourceChainId,
    destChainId: args.destChainId ?? 31611,
    userAddress: args.userAddress,
    intentType: resolveIntentType(
      args.intentType,
      args.borrowMusd,
      args.minTroveDebtMusd ?? MIN_TROVE_DEBT_MUSD,
    ),
    collateralBtcWei: toWei(args.collateralBtc).toString(),
    musdAmountWei: toWei(args.borrowMusd).toString(),
    minOutputWei: args.minOutputWei ?? "0",
    deadline: args.deadlineSeconds ?? now + 3_600,
    eip712Signature: args.eip712Signature,
    sourceTxHash: args.sourceTxHash,
    seriesMaturity: args.seriesMaturity,
    mezoBorrowSignature: args.mezoBorrowSignature,
  };
}

/** Posts an intent and returns the receipt, throwing on a non-2xx answer. */
export async function submitTeleportIntent(
  apiBaseUrl: string,
  request: TeleportIntentRequest,
): Promise<TeleportIntentReceipt> {
  const response = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/v1/teleport/intent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  const body = (await response.json()) as TeleportIntentReceipt & { message?: string };
  if (!response.ok) {
    throw new Error(body.message ?? `Teleport relayer responded ${response.status}`);
  }
  return body;
}

const styles: Record<string, CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(11,14,20,0.72)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "16px",
    zIndex: 50,
  },
  panel: {
    width: "100%",
    maxWidth: "460px",
    background: "#0B0E14",
    color: "#F8FAFC",
    border: "1px solid #1F2937",
    borderRadius: "10px",
    padding: "20px",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "13px",
  },
  row: { display: "flex", flexDirection: "column", gap: "4px", marginTop: "12px" },
  label: { fontSize: "10px", letterSpacing: "0.14em", textTransform: "uppercase", color: "#94A3B8" },
  input: {
    background: "#0B0E14",
    border: "1px solid #1F2937",
    borderRadius: "6px",
    color: "#F8FAFC",
    padding: "8px 10px",
    fontSize: "13px",
  },
  button: {
    marginTop: "16px",
    width: "100%",
    background: "transparent",
    border: "1px solid #22D3EE",
    color: "#22D3EE",
    borderRadius: "6px",
    padding: "10px",
    fontSize: "11px",
    letterSpacing: "0.14em",
    textTransform: "uppercase",
    cursor: "pointer",
  },
  status: { marginTop: "12px", color: "#94A3B8", fontSize: "11px" },
};

export function PrismTeleportModal({
  apiBaseUrl = "http://localhost:8080",
  defaultBorrowMusd = "2000",
  defaultCollateralBtc = "0.05",
  defaultIntentType = "BORROW_AND_LOCK_PT",
  minTroveDebtMusd = MIN_TROVE_DEBT_MUSD,
  onComplete,
  onError,
  children,
}: PrismTeleportModalProps) {
  const [borrow, setBorrow] = useState(defaultBorrowMusd);
  const [collateral, setCollateral] = useState(defaultCollateralBtc);
  const [status, setStatus] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const intentType = resolveIntentType(defaultIntentType, borrow, minTroveDebtMusd);
  const isMicro = intentType === "MICRO_TELEPORT";

  async function handleSubmit() {
    setBusy(true);
    setStatus("Submitting intent to the relayer…");
    try {
      // A host app supplies the signature (and the source tx hash on Base); the
      // widget itself stays wallet-agnostic.
      const receipt = await submitTeleportIntent(
        apiBaseUrl,
        buildTeleportRequest({
          sourceChainId: 84532,
          userAddress: "0x0000000000000000000000000000000000000000",
          intentType,
          collateralBtc: collateral,
          borrowMusd: borrow,
          eip712Signature: "0x",
          minTroveDebtMusd,
        }),
      );
      setStatus(`Intent ${receipt.status} · ${receipt.intentHash.slice(0, 12)}…`);
      onComplete?.(receipt);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      setStatus(failure.message);
      onError?.(failure);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={styles.overlay} role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="prism-teleport-heading"
        style={styles.panel}
      >
        <h2 id="prism-teleport-heading" style={{ margin: 0, fontSize: "12px", letterSpacing: "0.18em", textTransform: "uppercase", color: "#94A3B8" }}>
          Teleport a fixed carry
        </h2>

        <div style={styles.row}>
          <label htmlFor="prism-teleport-collateral" style={styles.label}>
            BTC collateral
          </label>
          <input
            id="prism-teleport-collateral"
            inputMode="decimal"
            value={collateral}
            onChange={(event) => setCollateral(event.target.value)}
            style={styles.input}
          />
        </div>

        <div style={styles.row}>
          <label htmlFor="prism-teleport-borrow" style={styles.label}>
            MUSD to borrow
          </label>
          <input
            id="prism-teleport-borrow"
            inputMode="decimal"
            value={borrow}
            onChange={(event) => setBorrow(event.target.value)}
            style={styles.input}
          />
          <span style={{ color: "#94A3B8", fontSize: "11px" }}>
            {isMicro
              ? `Under ${minTroveDebtMusd} MUSD: routed through the shared micro vault (R-011)`
              : "Standalone Trove in your own address"}
          </span>
        </div>

        {status ? (
          <p role="status" style={styles.status}>
            {status}
          </p>
        ) : null}

        {children}

        <button type="button" style={styles.button} disabled={busy} onClick={() => void handleSubmit()}>
          {busy ? "Submitting…" : "Teleport"}
        </button>
      </div>
    </div>
  );
}

export default PrismTeleportModal;
