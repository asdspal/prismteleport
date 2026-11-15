import { env } from "../config";
import { pool } from "../db/pool";
import { createMezoClients } from "../lib/mezoClient";
import { createIndexerWorker } from "./indexer";

/**
 * Standalone indexer process (`pnpm --filter @prism-teleport/relayer indexer`).
 * Runs one catch-up pass, then keeps polling so `prism_series`,
 * `yield_snapshots` and `user_positions` stay close to chain head (R-017).
 */
const worker = createIndexerWorker({
  db: pool,
  clients: createMezoClients(),
  pollIntervalMs: env.indexerPollMs,
  logger: (message, meta) => console.log(`[indexer] ${message}`, meta ?? ""),
});

const first = await worker.runOnce();
console.log(
  `[indexer] initial pass indexed ${first.length} chunk(s)`,
  first.map((s) => `${s.chainId}:${s.fromBlock}-${s.toBlock}(${s.logs} logs)`),
);
worker.start();
