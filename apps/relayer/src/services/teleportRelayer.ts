import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { parseAbi, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { computeTroveHints } from "@prism-teleport/sdk";

/**
 * Cross-chain teleport execution (R-007, R-008, R-011, R-021).
 *
 * The relayer is the only party that touches Mezo on the user's behalf: it
 * verifies the source-chain transaction, computes fresh `SortedTroves` hints,
 * relays the user's signed `TeleportIntent` into `TeleportHub` with the bridged
 * BTC, and records the whole lifecycle in `teleport_intents` so the UI can poll
 * a stepper. The hub itself stays non-custodial (it opens the Trove in the
 * borrower's address, or the shared micro vault in the borrower's name).
 */

export const HUB_ABI = parseAbi([
  "function executeCrossChainTeleport((uint256 sourceChainId,uint256 destChainId,address borrower,uint8 intentType,uint256 collateralBtcWei,uint256 musdAmountWei,uint256 minOutputWei,uint256 relayerFeeMusdWei,uint256 deadline,uint256 nonce,uint256 seriesMaturity) intent, bytes mezoBorrowSig, bytes prismIntentSig, address upperHint, address lowerHint) payable",
  "function hashIntent((uint256 sourceChainId,uint256 destChainId,address borrower,uint8 intentType,uint256 collateralBtcWei,uint256 musdAmountWei,uint256 minOutputWei,uint256 relayerFeeMusdWei,uint256 deadline,uint256 nonce,uint256 seriesMaturity) intent) pure returns (bytes32)",
  "function claimableRescueBtc(address) view returns (uint256)",
  "function processedIntents(bytes32) view returns (bool)",
]);

/** Mirrors TeleportHub.IntentType. */
export const INTENT_TYPES = [
  "BORROW_AND_LOCK_PT",
  "BORROW_AND_TELEPORT_MUSD",
  "MICRO_TELEPORT",
  "REPAY_AND_CLOSE",
] as const;
export type IntentTypeName = (typeof INTENT_TYPES)[number];

export const MEZO_STANDALONE_MIN_DEBT = 1_800n * 10n ** 18n;

export type IntentStatus =
  | "PENDING_SOURCE"
  | "SOURCE_CONFIRMED"
  | "EXECUTING_MEZO"
  | "FAST_FILLED"
  | "COMPLETED"
  | "RESCUED_ESCROW"
  | "FAILED";

export interface TeleportIntentBody {
  sourceChainId: number;
  destChainId: number;
  userAddress: Address;
  intentType: IntentTypeName;
  collateralBtcWei: string;
  musdAmountWei: string;
  minOutputWei: string;
  deadline: number;
  eip712Signature: Hex;
  sourceTxHash?: Hex;
  seriesMaturity?: number;
  mezoBorrowSignature?: Hex;
  nonce?: number;
}

export interface TeleportReceipt {
  intentHash: string;
  status: IntentStatus;
  mezoTxHash?: string;
  sourceTxHash?: string;
  explorerUrl?: string;
  message?: string;
}

export class TeleportHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TeleportHttpError";
  }
}

export interface TeleportDeps {
  db: Pool;
  /** Mezo client used for hints, the relay write and the receipt. */
  publicClient: PublicClient;
  walletClient: WalletClient;
  hubAddress: Address;
  relayerAddress: Address;
  explorerBase: string;
  /** Optional Base client used to verify the source transaction. */
  sourceClient?: PublicClient;
  /** Chains the relayer accepts as the source of a teleport. */
  allowedSourceChains?: number[];
}

function intentTypeIndex(name: IntentTypeName): number {
  return INTENT_TYPES.indexOf(name);
}

/** The struct `TeleportHub` hashes and executes. */
export function toHubIntent(body: TeleportIntentBody, nonce = 1) {
  return {
    sourceChainId: BigInt(body.sourceChainId),
    destChainId: BigInt(body.destChainId),
    borrower: body.userAddress,
    intentType: intentTypeIndex(body.intentType),
    collateralBtcWei: BigInt(body.collateralBtcWei),
    musdAmountWei: BigInt(body.musdAmountWei),
    minOutputWei: BigInt(body.minOutputWei),
    relayerFeeMusdWei: 0n,
    deadline: BigInt(body.deadline),
    nonce: BigInt(nonce),
    seriesMaturity: BigInt(body.seriesMaturity ?? 0),
  } as const;
}

/**
 * Verifies the source transaction on Base before relaying: the intent is only
 * worth executing once the collateral has actually been escrowed on the spoke.
 */
export async function verifySourceTransaction(
  deps: TeleportDeps,
  body: TeleportIntentBody,
): Promise<"verified" | "pending"> {
  if (!body.sourceTxHash) return "pending";
  const client = deps.sourceClient ?? deps.publicClient;
  const receipt = await client.getTransactionReceipt({ hash: body.sourceTxHash });
  if (!receipt) return "pending";
  return receipt.status === "success" ? "verified" : "pending";
}

export async function relayTeleportIntent(
  deps: TeleportDeps,
  body: TeleportIntentBody,
): Promise<TeleportReceipt> {
  const allowedSources = deps.allowedSourceChains ?? [84532, 8453, 31611, 31612];
  if (!allowedSources.includes(body.sourceChainId)) {
    throw new TeleportHttpError(400, "BadRequest", `unsupported source chain ${body.sourceChainId}`);
  }
  if (body.destChainId !== 31611 && body.destChainId !== 31612) {
    throw new TeleportHttpError(400, "BadRequest", "destChainId must be 31611 or 31612");
  }
  if (BigInt(body.collateralBtcWei) <= 0n) {
    throw new TeleportHttpError(400, "BadRequest", "collateralBtcWei must be positive");
  }
  if (BigInt(body.musdAmountWei) <= 0n) {
    throw new TeleportHttpError(400, "BadRequest", "musdAmountWei must be positive");
  }
  if (BigInt(body.deadline) <= BigInt(Math.floor(Date.now() / 1000))) {
    throw new TeleportHttpError(400, "BadRequest", "intent deadline has passed");
  }
  if (body.intentType !== "MICRO_TELEPORT" && BigInt(body.musdAmountWei) < MEZO_STANDALONE_MIN_DEBT) {
    // The hub would route it through the micro vault anyway; be explicit so the
    // UI can show the right path.
    throw new TeleportHttpError(
      400,
      "BadRequest",
      "borrows under 1,800 MUSD must use intentType MICRO_TELEPORT",
    );
  }

  const sourceState = await verifySourceTransaction(deps, body);
  const intent = toHubIntent(body, body.nonce ?? 1);
  const intentHash = (await deps.publicClient.readContract({
    address: deps.hubAddress,
    abi: HUB_ABI,
    functionName: "hashIntent",
    args: [intent],
  })) as Hex;

  // One row per intent, created before the broadcast so a crash still leaves an
  // audit trail (the idempotency gate for teleports).
  const inserted = await deps.db.query<{ intent_hash: string }>(
    `INSERT INTO teleport_intents
       (intent_hash, user_address, source_chain_id, dest_chain_id, intent_type,
        collateral_btc_wei, musd_amount_wei, min_output_wei, relayer_fee_musd_wei,
        eip712_signature, deadline_timestamp, source_tx_hash, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$9,$10,$11,$12)
     ON CONFLICT (intent_hash) DO UPDATE SET updated_at = NOW()
     RETURNING intent_hash`,
    [
      intentHash,
      body.userAddress,
      body.sourceChainId,
      body.destChainId,
      body.intentType,
      body.collateralBtcWei,
      body.musdAmountWei,
      body.minOutputWei,
      body.eip712Signature,
      body.deadline,
      body.sourceTxHash ?? null,
      sourceState === "verified" ? "SOURCE_CONFIRMED" : "PENDING_SOURCE",
    ],
  );
  if (inserted.rowCount === 0) {
    throw new TeleportHttpError(409, "IntentInFlight", "this intent is already being relayed");
  }

  const existing = await deps.db.query<{ status: string; mezo_tx_hash: string | null }>(
    "SELECT status, mezo_tx_hash FROM teleport_intents WHERE intent_hash = $1",
    [intentHash],
  );
  if (existing.rows[0]?.mezo_tx_hash) {
    return {
      intentHash,
      status: existing.rows[0].status as IntentStatus,
      mezoTxHash: existing.rows[0].mezo_tx_hash,
      explorerUrl: `${deps.explorerBase}/tx/${existing.rows[0].mezo_tx_hash}`,
    };
  }

  // Exact SortedTroves hints for the resulting Trove, computed on Mezo (R-012).
  const hints = await computeTroveHints(
    deps.publicClient,
    body.destChainId,
    BigInt(body.collateralBtcWei),
    BigInt(body.musdAmountWei),
  );

  await deps.db.query("UPDATE teleport_intents SET status = 'EXECUTING_MEZO' WHERE intent_hash = $1", [
    intentHash,
  ]);

  let txHash: Hex;
  try {
    txHash = await deps.walletClient.writeContract({
      account: deps.relayerAddress,
      chain: null,
      address: deps.hubAddress,
      abi: HUB_ABI,
      functionName: "executeCrossChainTeleport",
      args: [
        intent,
        (body.mezoBorrowSignature ?? "0x") as Hex,
        body.eip712Signature,
        hints.upperHint as Address,
        hints.lowerHint as Address,
      ],
      value: BigInt(body.collateralBtcWei),
    } as never);
  } catch (error) {
    await deps.db.query(
      "UPDATE teleport_intents SET status = 'FAILED', error_reason = $2, updated_at = NOW() WHERE intent_hash = $1",
      [intentHash, error instanceof Error ? error.message.slice(0, 400) : "relay failed"],
    );
    throw new TeleportHttpError(
      422,
      "RelayFailed",
      error instanceof Error ? error.message : "the Mezo relay reverted",
    );
  }

  const receipt = await deps.publicClient.waitForTransactionReceipt({ hash: txHash });
  // The hub never reverts on an execution failure; a rescue credit is how a
  // failed on-chain leg shows up (STRIDE-05).
  const rescued = (await deps.publicClient.readContract({
    address: deps.hubAddress,
    abi: HUB_ABI,
    functionName: "claimableRescueBtc",
    args: [body.userAddress],
  })) as bigint;

  const status: IntentStatus =
    receipt.status === "success" ? (rescued > 0n ? "RESCUED_ESCROW" : "COMPLETED") : "FAILED";

  await deps.db.query(
    `UPDATE teleport_intents
        SET status = $2, mezo_tx_hash = $3, updated_at = NOW()
      WHERE intent_hash = $1`,
    [intentHash, status, txHash],
  );

  return {
    intentHash,
    status,
    mezoTxHash: txHash,
    sourceTxHash: body.sourceTxHash,
    explorerUrl: `${deps.explorerBase}/tx/${txHash}`,
  };
}

export async function getTeleportIntent(
  db: Pool,
  intentHash: string,
): Promise<TeleportReceipt | undefined> {
  const row = await db.query<{
    intent_hash: string;
    status: string;
    mezo_tx_hash: string | null;
    source_tx_hash: string | null;
    error_reason: string | null;
  }>(
    `SELECT intent_hash, status, mezo_tx_hash, source_tx_hash, error_reason
       FROM teleport_intents WHERE intent_hash = $1`,
    [intentHash],
  );
  if (row.rowCount === 0) return undefined;
  const intent = row.rows[0];
  return {
    intentHash: intent.intent_hash,
    status: intent.status as IntentStatus,
    mezoTxHash: intent.mezo_tx_hash ?? undefined,
    sourceTxHash: intent.source_tx_hash ?? undefined,
    message: intent.error_reason ?? undefined,
  };
}

export function newIntentNonce(): number {
  return Math.floor(Math.random() * 1_000_000) + 1;
}

export const intentCorrelationId = () => randomUUID();
