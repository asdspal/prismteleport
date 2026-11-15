import type { Pool, PoolClient } from "pg";
import { parseAbiItem, type Address, type Log, type PublicClient } from "viem";
import { getLogsChunked } from "../lib/mezoClient";
import {
  fetchMarketsOnChain,
  fetchUserPortfolioOnChain,
  MEZO_READ_CONTRACTS,
} from "@prism-teleport/sdk/multicallReaders";

/**
 * Chunked on-chain log/state indexer (R-017).
 *
 * Scans Prism events in `<= maxSpan` block windows (Mezo public RPCs reject wide
 * `eth_getLogs` ranges), and per chunk — inside one PostgreSQL transaction —
 * refreshes `prism_series`, appends `yield_snapshots`, caches `user_positions`
 * for every address seen in the chunk, and advances `indexer_checkpoints`.
 */

export const DEFAULT_MAX_SPAN = 9_000n;

export interface IndexerLogger {
  (message: string, meta?: Record<string, unknown>): void;
}

export interface IndexerOptions {
  db: Pool;
  clients: { testnet: PublicClient; mainnet: PublicClient };
  chainIds?: number[];
  startBlocks?: Record<number, bigint>;
  maxSpan?: bigint;
  /** Upper bound on chunks scanned per `runOnce()` call. */
  maxChunksPerRun?: number;
  /** Upper bound on portfolio refreshes per chunk (pathological log storms). */
  maxAddressesPerChunk?: number;
  pollIntervalMs?: number;
  logger?: IndexerLogger;
}

export interface ChunkSummary {
  chainId: number;
  fromBlock: bigint;
  toBlock: bigint;
  logs: number;
  addresses: number;
}

const PRISM_EVENT_ABI = [
  "event SeriesInitialized(uint256 indexed maturity, address ptToken, address ytToken, uint256 rateAtInit)",
  "event PyMinted(uint256 indexed maturity, address indexed receiver, uint256 amount)",
  "event PyRedeemed(uint256 indexed maturity, address indexed user, address indexed receiver, uint256 amount)",
  "event PtRedeemed(uint256 indexed maturity, address indexed user, address indexed receiver, uint256 amount)",
  "event YieldPaid(address indexed user, address indexed receiver, uint256 musdAmount, uint256 mezoAmount)",
  "event SeriesFinalized(uint256 indexed maturity, uint256 finalRate)",
  "event TrackAprsUpdated(uint256 gaugeMezoAprBps, uint256 unstakedFeeAprBps)",
  "event PoolInitialized(uint256 indexed maturity, address pt, address yt)",
  "event LiquidityAdded(uint256 indexed maturity, address indexed provider, uint256 musdIn, uint256 ptIn, uint256 shares)",
  "event LiquidityRemoved(uint256 indexed maturity, address indexed provider, uint256 musdOut, uint256 ptOut, uint256 shares)",
  "event SwappedMusdForPt(uint256 indexed maturity, address indexed user, uint256 musdIn, uint256 ptOut)",
  "event SwappedPtForMusd(uint256 indexed maturity, address indexed user, uint256 ptIn, uint256 musdOut)",
  "event SwappedMusdForYt(uint256 indexed maturity, address indexed user, uint256 musdIn, uint256 ytOut)",
  "event SwapFeeCollected(uint256 indexed maturity, address indexed user, uint256 feeMusd)",
  "event Staked(address indexed user, uint256 amount)",
  "event Unstaked(address indexed user, uint256 amount)",
  "event RewardsClaimed(address indexed user, uint256 musdAmount)",
  "event FeeRevenueNotified(address indexed source, uint256 musdAmount)",
  "event TrackModeSwitched(uint8 indexed previousMode, uint8 indexed newMode, uint256 unstakedAprBps, uint256 gaugeAprBps)",
  "event GaugeRewardsHarvested(uint256 mezoAmount)",
  "event SmusdYieldHarvested(uint256 musdAmount)",
  "event AprsUpdated(uint256 unstakedAprBps, uint256 gaugeAprBps)",
  "event BorrowedAndLockedFixedCarry(address indexed borrower, uint256 musdBorrowed, uint256 ptOut, uint256 relayerFeeMusd, uint256 maturity)",
] as const;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Every 20-byte address appearing in a log's args, minus the emitters themselves. */
function addressesIn(logs: Log[], excluded: Set<string>): Address[] {
  const seen = new Set<string>();
  for (const log of logs) {
    const args = (log as unknown as { args?: Record<string, unknown> }).args;
    if (!args) continue;
    for (const value of Object.values(args)) {
      if (typeof value !== "string" || !ADDRESS_RE.test(value)) continue;
      const lower = value.toLowerCase();
      if (excluded.has(lower) || /^0x0{40}$/.test(lower)) continue;
      seen.add(lower);
    }
  }
  return [...seen] as Address[];
}

export function createIndexerWorker(options: IndexerOptions) {
  const {
    db,
    clients,
    chainIds = [31611, 31612],
    maxSpan = DEFAULT_MAX_SPAN,
    maxChunksPerRun = 50,
    maxAddressesPerChunk = 25,
    pollIntervalMs = 30_000,
    logger = () => undefined,
  } = options;

  let timer: NodeJS.Timeout | undefined;
  let running = false;

  async function startBlock(chainId: number): Promise<bigint> {
    const configured = options.startBlocks?.[chainId];
    if (configured !== undefined) return configured;
    if (chainId === 31611) {
      const { env } = await import("../config");
      return env.indexerStartBlock31611;
    }
    return 0n;
  }

  function clientFor(chainId: number): PublicClient {
    return chainId === 31612 ? clients.mainnet : clients.testnet;
  }

  async function checkpoint(chainId: number): Promise<bigint> {
    const row = await db.query<{ last_indexed_block: string }>(
      "SELECT last_indexed_block FROM indexer_checkpoints WHERE chain_id = $1",
      [chainId],
    );
    if (row.rowCount === 0) return await startBlock(chainId);
    return BigInt(row.rows[0].last_indexed_block);
  }

  async function processChunk(
    chainId: number,
    client: PublicClient,
    logs: Log[],
    toBlock: bigint,
  ): Promise<number> {
    // A single connection per chunk: BEGIN/COMMIT must run on one backend.
    const conn: PoolClient = await db.connect();
    try {
      return await processChunkOn(conn, chainId, client, logs, toBlock);
    } finally {
      conn.release();
    }
  }

  async function processChunkOn(
    conn: PoolClient,
    chainId: number,
    client: PublicClient,
    logs: Log[],
    toBlock: bigint,
  ): Promise<number> {
    const contracts = MEZO_READ_CONTRACTS[chainId];
    const watched = [
      contracts.tokenizer,
      contracts.amm,
      contracts.adapter,
      contracts.feeStaking,
    ].filter((a): a is Address => Boolean(a));
    if (watched.length === 0) return 0;

    const excluded = new Set(watched.map((a) => a.toLowerCase()));
    const addresses = addressesIn(logs, excluded).slice(0, maxAddressesPerChunk);

    // One transaction per chunk: series refresh + snapshots + user cache + checkpoint.
    await conn.query("BEGIN");
    try {
      if (logs.length > 0 && contracts.tokenizer) {
        const markets = await fetchMarketsOnChain(client, chainId, {
          blockNumber: toBlock,
        });
        for (const series of markets.series) {
          const upserted = await db.query<{ series_id: string }>(
            `INSERT INTO prism_series
               (chain_id, maturity_timestamp, tokenizer_address, amm_address,
                pt_token_address, yt_token_address, initial_smusd_rate, smoothed_smusd_rate,
                fixed_apy_bps, implied_yt_apy_bps, active_adapter_mode, total_smusd_locked, is_matured)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
             ON CONFLICT (chain_id, maturity_timestamp) DO UPDATE SET
               tokenizer_address = EXCLUDED.tokenizer_address,
               amm_address = EXCLUDED.amm_address,
               pt_token_address = EXCLUDED.pt_token_address,
               yt_token_address = EXCLUDED.yt_token_address,
               smoothed_smusd_rate = EXCLUDED.smoothed_smusd_rate,
               fixed_apy_bps = EXCLUDED.fixed_apy_bps,
               implied_yt_apy_bps = EXCLUDED.implied_yt_apy_bps,
               active_adapter_mode = EXCLUDED.active_adapter_mode,
               total_smusd_locked = EXCLUDED.total_smusd_locked,
               is_matured = EXCLUDED.is_matured,
               updated_at = NOW()
             RETURNING series_id`,
            [
              chainId,
              series.maturityTimestamp,
              contracts.tokenizer,
              contracts.amm,
              series.ptTokenAddress,
              series.ytTokenAddress,
              series.rateAtInit,
              series.smoothedRate,
              series.fixedPtApyBps,
              series.impliedYtApyBps,
              series.activeAdapterMode,
              series.totalSmusdLocked,
              series.isMatured,
            ],
          );

          await conn.query(
            `INSERT INTO yield_snapshots
               (series_id, block_number, unstaked_fee_apr_bps, gauge_mezo_apr_bps,
                fixed_pt_apr_bps, mezo_twap_usd, adapter_mode)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [
              upserted.rows[0].series_id,
              toBlock.toString(),
              markets.unstakedFeeAprBps,
              markets.gaugeMezoAprBps,
              series.fixedPtApyBps,
              // No MEZO/USD oracle exists on-chain in this deployment (documented
              // deviation): the gauge APR columns carry the yield signal instead.
              "0",
              series.activeAdapterMode,
            ],
          );
        }
      }

      for (const address of addresses) {
        const portfolio = await fetchUserPortfolioOnChain(client, chainId, address, {
          blockNumber: toBlock,
        });
        await conn.query(
          `INSERT INTO user_positions
             (user_address, chain_id, trove_collateral_btc, trove_debt_musd, trove_icr_bps,
              pt_balance, yt_balance, claimable_yield_musd, claimable_yield_mezo,
              staked_mezo_balance, fee_discount_bps, last_synced_block, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
           ON CONFLICT (user_address, chain_id) DO UPDATE SET
             trove_collateral_btc = EXCLUDED.trove_collateral_btc,
             trove_debt_musd = EXCLUDED.trove_debt_musd,
             trove_icr_bps = EXCLUDED.trove_icr_bps,
             pt_balance = EXCLUDED.pt_balance,
             yt_balance = EXCLUDED.yt_balance,
             claimable_yield_musd = EXCLUDED.claimable_yield_musd,
             claimable_yield_mezo = EXCLUDED.claimable_yield_mezo,
             staked_mezo_balance = EXCLUDED.staked_mezo_balance,
             fee_discount_bps = EXCLUDED.fee_discount_bps,
             last_synced_block = EXCLUDED.last_synced_block,
             updated_at = NOW()`,
          [
            address,
            chainId,
            portfolio.troveCollateralBtc,
            portfolio.troveDebtMusd,
            portfolio.troveIcrBps,
            portfolio.ptBalance,
            portfolio.ytBalance,
            portfolio.claimableYieldMusd,
            portfolio.claimableYieldMezo,
            portfolio.stakedMezoBalance,
            portfolio.feeDiscountBps,
            portfolio.lastSyncedBlock,
          ],
        );
      }

      await conn.query(
        `INSERT INTO indexer_checkpoints (chain_id, last_indexed_block, updated_at)
         VALUES ($1,$2,NOW())
         ON CONFLICT (chain_id) DO UPDATE SET
           last_indexed_block = EXCLUDED.last_indexed_block,
           updated_at = NOW()`,
        [chainId, toBlock.toString()],
      );
      await conn.query("COMMIT");
    } catch (error) {
      await conn.query("ROLLBACK");
      throw error;
    }

    return addresses.length;
  }

  async function runOnce(): Promise<ChunkSummary[]> {
    const summaries: ChunkSummary[] = [];

    for (const chainId of chainIds) {
      const contracts = MEZO_READ_CONTRACTS[chainId];
      const watched = [
        contracts.tokenizer,
        contracts.amm,
        contracts.adapter,
        contracts.feeStaking,
      ].filter((a): a is Address => Boolean(a));
      if (watched.length === 0) continue;

      const client = clientFor(chainId);
      const latest = await client.getBlockNumber();
      let from = (await checkpoint(chainId)) + 1n;

      for (let chunk = 0; chunk < maxChunksPerRun && from <= latest; chunk++) {
        const to = from + maxSpan - 1n > latest ? latest : from + maxSpan - 1n;
        const logs = await getLogsChunked(
          client,
          {
            address: watched,
            fromBlock: from,
            toBlock: to,
            events: PRISM_EVENT_ABI.map((signature) => parseAbiItem(signature)),
          },
          maxSpan,
        );
        const addresses = await processChunk(chainId, client, logs, to);
        summaries.push({ chainId, fromBlock: from, toBlock: to, logs: logs.length, addresses });
        logger("indexer chunk indexed", {
          chainId,
          fromBlock: from.toString(),
          toBlock: to.toString(),
          logs: logs.length,
          addresses,
        });
        from = to + 1n;
      }
    }

    return summaries;
  }

  function start(): void {
    if (timer) return;
    timer = setInterval(() => {
      if (running) return;
      running = true;
      void runOnce()
        .catch((error: unknown) => logger("indexer run failed", { error: String(error) }))
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

  return { runOnce, start, stop, maxSpan };
}
