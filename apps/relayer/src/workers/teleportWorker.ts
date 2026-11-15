import type { Pool } from "pg";
import type { Hex, PublicClient } from "viem";
import { HUB_ABI } from "../services/teleportRelayer";
import type { Address } from "viem";

/**
 * Teleport status worker (R-018, STRIDE-05).
 *
 * The relay route writes a `teleport_intents` row per intent; this worker keeps
 * the lifecycle honest for rows whose Mezo transaction was broadcast but whose
 * receipt had not landed yet, and flags anything that landed in the rescue
 * escrow so the UI can surface the claim banner.
 */

export interface TeleportWorkerOptions {
  db: Pool;
  publicClient: Pick<PublicClient, "getTransactionReceipt" | "readContract">;
  hubAddress: Address;
  pollIntervalMs?: number;
  batchSize?: number;
  logger?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface TeleportWorkerSummary {
  checked: number;
  completed: number;
  rescued: number;
  failed: number;
}

export function createTeleportWorker(options: TeleportWorkerOptions) {
  const { db, publicClient, hubAddress, pollIntervalMs = 20_000, batchSize = 25 } = options;
  const logger = options.logger ?? (() => undefined);
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  async function runOnce(): Promise<TeleportWorkerSummary> {
    const pending = await db.query<{
      intent_hash: string;
      user_address: string;
      mezo_tx_hash: string | null;
      status: string;
    }>(
      `SELECT intent_hash, user_address, mezo_tx_hash, status
         FROM teleport_intents
        WHERE status IN ('PENDING_SOURCE', 'SOURCE_CONFIRMED', 'EXECUTING_MEZO')
        ORDER BY updated_at ASC
        LIMIT $1`,
      [batchSize],
    );

    const summary: TeleportWorkerSummary = { checked: 0, completed: 0, rescued: 0, failed: 0 };

    for (const row of pending.rows) {
      summary.checked += 1;
      if (!row.mezo_tx_hash) {
        // Nothing was broadcast yet: the route owns this transition.
        continue;
      }

      const receipt = await publicClient
        .getTransactionReceipt({ hash: row.mezo_tx_hash as Hex })
        .catch(() => undefined);

      if (!receipt) {
        logger("teleport receipt pending", { intentHash: row.intent_hash });
        continue;
      }

      if (receipt.status !== "success") {
        await db.query(
          `UPDATE teleport_intents SET status = 'FAILED', updated_at = NOW() WHERE intent_hash = $1`,
          [row.intent_hash],
        );
        summary.failed += 1;
        continue;
      }

      const rescued = (await publicClient.readContract({
        address: hubAddress,
        abi: HUB_ABI,
        functionName: "claimableRescueBtc",
        args: [row.user_address as Address],
      })) as bigint;

      const status = rescued > 0n ? "RESCUED_ESCROW" : "COMPLETED";
      await db.query(
        `UPDATE teleport_intents SET status = $2, updated_at = NOW() WHERE intent_hash = $1`,
        [row.intent_hash, status],
      );
      if (status === "RESCUED_ESCROW") summary.rescued += 1;
      else summary.completed += 1;
      logger("teleport settled", { intentHash: row.intent_hash, status });
    }

    return summary;
  }

  function start(): void {
    if (timer) return;
    timer = setInterval(() => {
      if (running) return;
      running = true;
      void runOnce()
        .catch((error: unknown) => logger("teleport worker failed", { error: String(error) }))
        .finally(() => {
          running = false;
        });
    }, pollIntervalMs);
    timer.unref?.();
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = undefined;
  }

  return { runOnce, start, stop };
}
