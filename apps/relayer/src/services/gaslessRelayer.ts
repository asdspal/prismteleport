import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { Redis } from "ioredis";
import {
  BaseError,
  ContractFunctionRevertedError,
  encodeFunctionData,
  parseAbi,
  toFunctionSelector,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { waitForReceiptResilient } from "../lib/mezoClient";

export const ROUTER_ABI = parseAbi([
  "function borrowAndLockFixedYield((address borrower,uint256 musdBorrowAmount,uint256 maturity,uint256 minPtOut,uint256 relayerFeeMusd,uint256 nonce,uint256 deadline,uint256 mezoDeadline,address upperHint,address lowerHint) p, bytes mezoBorrowSig, bytes prismLockSig) returns (uint256 ptOut)",
  "error ERC20InsufficientAllowance(address spender,uint256 allowance,uint256 needed)",
  "error ERC20InsufficientBalance(address sender,uint256 balance,uint256 needed)",
  "error ReentrancyGuardReentrantCall()",
]);

export const BORROW_FN_SELECTOR = toFunctionSelector(
  "borrowAndLockFixedYield((address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,address,address),bytes,bytes)",
);

/** STRIDE-04: max relayed transactions per borrower address per minute. */
export const RELAYS_PER_MINUTE = 3;
/** Max tx gasLimit the relay will ever broadcast (pad included). */
export const MAX_RELAY_GAS = 1_500_000n;

export interface RelayBorrowLockBody {
  chainId: number;
  borrower: string;
  musdBorrowAmountWei: string;
  seriesMaturity: number;
  minPtOutWei: string;
  upperHint: string;
  lowerHint: string;
  deadline: number;
  relayerFeeMusd: string;
  nonce: string | number;
  mezoDeadline: number;
  eip712Signature: string;
  mezoBorrowSig: string;
}

export interface RelayTxResponse {
  relayId: string;
  txHash: string;
  status: "SUBMITTED" | "CONFIRMED";
  explorerUrl: string;
}

export class RelayHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface RelayDeps {
  db: Pool;
  redis: Pick<Redis, "set" | "eval" | "incr" | "expire">;
  publicClient: Pick<
    PublicClient,
    "simulateContract" | "getBytecode" | "getTransactionCount" | "estimateGas"
  > & { getTransactionReceipt: PublicClient["getTransactionReceipt"] };
  walletClient: WalletClient;
  relayerAddress: Address;
  routerAddress: Address;
  explorerBase: string;
  eip7702Whitelist: readonly string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeRevertReason(error: unknown): string {
  if (error instanceof ContractFunctionRevertedError) {
    return error.reason ?? error.data?.errorName ?? error.shortMessage;
  }
  if (error instanceof BaseError) {
    const reverted = error.walk(
      (err) => err instanceof ContractFunctionRevertedError,
    );
    if (reverted instanceof ContractFunctionRevertedError) {
      return reverted.reason ?? reverted.data?.errorName ?? reverted.shortMessage;
    }
    return error.shortMessage;
  }
  return error instanceof Error ? error.message : String(error);
}

const RELEASE_LOCK_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

async function acquireNonceLock(
  redis: Pick<Redis, "set" | "eval">,
  key: string,
  token: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const ok = await redis.set(key, token, "PX", 15_000, "NX");
    if (ok) return;
    if (Date.now() > deadline) {
      throw new RelayHttpError(
        503,
        "NonceLockTimeout",
        "relayer is broadcasting another transaction, retry shortly",
      );
    }
    await sleep(50);
  }
}

async function releaseNonceLock(
  redis: Pick<Redis, "set" | "eval">,
  key: string,
  token: string,
): Promise<void> {
  try {
    await redis.eval(RELEASE_LOCK_LUA, 1, key, token);
  } catch {
    /* lock expires via its 15s TTL anyway */
  }
}

interface RelayRow {
  relay_id: string;
  tx_hash: string | null;
  status: string;
  created_at: Date;
}

async function loadByIdempotency(
  db: Pool,
  key: string,
): Promise<RelayRow | undefined> {
  const res = await db.query<RelayRow>(
    "SELECT relay_id, tx_hash, status, created_at FROM relayer_transactions WHERE idempotency_key = $1",
    [key],
  );
  return res.rows[0];
}

function rowToResponse(row: RelayRow, explorerBase: string): RelayTxResponse {
  const txHash = row.tx_hash ?? "";
  return {
    relayId: row.relay_id,
    txHash,
    status: row.status === "CONFIRMED" ? "CONFIRMED" : "SUBMITTED",
    explorerUrl: explorerBase + txHash,
  };
}

export async function relayBorrowAndLock(
  idempotencyKey: string,
  body: RelayBorrowLockBody,
  deps: RelayDeps,
): Promise<RelayTxResponse> {
  const { db, redis, publicClient, walletClient, relayerAddress, routerAddress, explorerBase } =
    deps;

  // 1. Idempotency gate: a replayed key returns the first relay without re-broadcasting.
  const existing = await loadByIdempotency(db, idempotencyKey);
  if (existing?.tx_hash) return rowToResponse(existing, explorerBase);
  if (existing) {
    const ageMs = Date.now() - new Date(existing.created_at).getTime();
    if (ageMs > 30_000) {
      // crashed broadcast left a stale QUEUED row: free the key and retry
      await db.query(
        "DELETE FROM relayer_transactions WHERE relay_id = $1 AND tx_hash IS NULL",
        [existing.relay_id],
      );
    } else {
      // an identical request is mid-flight: wait for it to publish its hash
      for (let i = 0; i < 40; i++) {
        await sleep(50);
        const fresh = await loadByIdempotency(db, idempotencyKey);
        if (fresh?.tx_hash) return rowToResponse(fresh, explorerBase);
        if (!fresh) break; // concurrent stale cleanup freed the key
      }
      const last = await loadByIdempotency(db, idempotencyKey);
      if (last?.tx_hash) return rowToResponse(last, explorerBase);
      if (last) {
        throw new RelayHttpError(
          409,
          "RelayInFlight",
          "identical Idempotency-Key is already in flight",
        );
      }
    }
  }

  // 2. GAP-005: never sponsor an EIP-7702 delegated EOA outside the whitelist.
  const bytecode = await publicClient.getBytecode({ address: body.borrower as Address });
  if (bytecode && bytecode.startsWith("0xef0100")) {
    const impl = `0x${bytecode.slice(8, 48)}`.toLowerCase();
    if (!deps.eip7702Whitelist.includes(impl)) {
      throw new RelayHttpError(
        400,
        "EIP7702DelegationBlocked",
        `borrower ${body.borrower} uses a non-whitelisted EIP-7702 delegation`,
      );
    }
  }

  // 3. STRIDE-04: per-address rate limit.
  const rlKey = `rl:relay:${body.chainId}:${body.borrower.toLowerCase()}`;
  const count = await redis.incr(rlKey);
  if (count === 1) await redis.expire(rlKey, 60);
  if (count > RELAYS_PER_MINUTE) {
    throw new RelayHttpError(
      429,
      "RateLimited",
      `max ${RELAYS_PER_MINUTE} relayed transactions per minute per address`,
    );
  }

  const params = {
    borrower: body.borrower as Address,
    musdBorrowAmount: BigInt(body.musdBorrowAmountWei),
    maturity: BigInt(body.seriesMaturity),
    minPtOut: BigInt(body.minPtOutWei),
    relayerFeeMusd: BigInt(body.relayerFeeMusd),
    nonce: BigInt(body.nonce),
    deadline: BigInt(body.deadline),
    mezoDeadline: BigInt(body.mezoDeadline),
    upperHint: body.upperHint as Address,
    lowerHint: body.lowerHint as Address,
  };

  // 4. STRIDE-04: pre-broadcast simulation - a revert costs zero relayer gas.
  let request: unknown;
  try {
    const sim = await publicClient.simulateContract({
      account: relayerAddress,
      address: routerAddress,
      abi: ROUTER_ABI,
      functionName: "borrowAndLockFixedYield",
      args: [params, body.mezoBorrowSig as Hex, body.eip712Signature as Hex],
    });
    request = sim.request;
  } catch (error) {
    throw new RelayHttpError(422, "SimulationReverted", decodeRevertReason(error));
  }

  // 4b. Gas: never trust a bare estimate as the tx limit — state/timing drift
    // between estimation and inclusion makes an exact-limit tx OOG inside a
    // subcall (observed: 772k estimated, 800k needed on the fork). Pad 25%,
    // and cap the limit so a pathological estimate can't become a griefing
    // vector: a reverted tx burns up to its whole gasLimit.
    let gas: bigint;
    try {
      const estimate = await publicClient.estimateGas({
        account: relayerAddress,
        to: routerAddress,
        data: encodeFunctionData({
          abi: ROUTER_ABI,
          functionName: "borrowAndLockFixedYield",
          args: [params, body.mezoBorrowSig as Hex, body.eip712Signature as Hex],
        }),
      });
      gas = estimate + (estimate >> 2n);
      if (gas > MAX_RELAY_GAS) {
        throw new RelayHttpError(
          422,
          "SimulationReverted",
          `gas estimate ${estimate} exceeds relay cap`,
        );
      }
    } catch (error) {
      if (error instanceof RelayHttpError) throw error;
      throw new RelayHttpError(422, "SimulationReverted", decodeRevertReason(error));
    }

    // 5. Serialized nonce: lock -> INSERT (idempotency UNIQUE) -> broadcast -> row update.
  const lockKey = `lock:relayer:nonce:${body.chainId}`;
  const lockToken = randomUUID();
  await acquireNonceLock(redis, lockKey, lockToken);

  try {
    const nonce = await publicClient.getTransactionCount({
      address: relayerAddress,
      blockTag: "pending",
    });

    let relayId: string;
    try {
      const inserted = await db.query<{ relay_id: string }>(
        `INSERT INTO relayer_transactions
           (idempotency_key, chain_id, user_address, target_contract, function_selector,
            relayer_nonce, reimbursed_musd_wei, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'QUEUED')
         RETURNING relay_id`,
        [
          idempotencyKey,
          body.chainId,
          body.borrower,
          routerAddress,
          BORROW_FN_SELECTOR,
          nonce,
          body.relayerFeeMusd,
        ],
      );
      relayId = inserted.rows[0].relay_id;
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        const dup = await loadByIdempotency(db, idempotencyKey);
        if (dup?.tx_hash) return rowToResponse(dup, explorerBase);
      }
      throw error;
    }

    let txHash: Hex;
    try {
      txHash = await walletClient.writeContract({
        ...(request as object),
        gas,
      } as never);
    } catch (error) {
      await db.query(
        "DELETE FROM relayer_transactions WHERE relay_id = $1 AND tx_hash IS NULL",
        [relayId],
      );
      throw new RelayHttpError(422, "BroadcastFailed", decodeRevertReason(error));
    }

    await db.query(
      "UPDATE relayer_transactions SET tx_hash = $1, status = 'SUBMITTED' WHERE relay_id = $2",
      [txHash, relayId],
    );

    // 6. R-017: resilient receipt tracking in the background; 202 returns immediately.
    void waitForReceiptResilient(publicClient, txHash)
      .then(async (receipt) => {
        const status = receipt.status === "success" ? "CONFIRMED" : "REVERTED";
        const gasCost = receipt.gasUsed * (receipt.effectiveGasPrice ?? 0n);
        await db.query(
          `UPDATE relayer_transactions
              SET status = $1, gas_used = $2, gas_cost_btc_wei = $3, confirmed_at = NOW()
            WHERE relay_id = $4`,
          [status, receipt.gasUsed.toString(), gasCost.toString(), relayId],
        );
      })
      .catch(() => {
        /* GAP-004: null receipts are a known Mezo RPC lag - leave the row SUBMITTED */
      });

    return {
      relayId,
      txHash,
      status: "SUBMITTED",
      explorerUrl: explorerBase + txHash,
    };
  } finally {
    await releaseNonceLock(redis, lockKey, lockToken);
  }
}
