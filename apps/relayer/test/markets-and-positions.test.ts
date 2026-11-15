import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import type { Address, Log } from "viem";
import { createMezoClients, getLogsChunked } from "../src/lib/mezoClient";
import { DATABASE_URL, runMigrations } from "../src/db/migrate";
import { pool } from "../src/db/pool";
import { createIndexerWorker, DEFAULT_MAX_SPAN } from "../src/workers/indexer";
import {
  fetchMarketsOnChain,
  fetchUserPortfolioOnChain,
} from "@prism-teleport/sdk/multicallReaders";
import { buildServer } from "../src/server";
import type { FastifyInstance } from "fastify";

const DEPLOYER = "0xfCe44470aC130E66849Aaa23F81D092066ff501E" as Address;
const MATURITY_4W = 1795046400;
const MATURITY_12W = 1799884800;
const M1_E2E_FIRST_BLOCK = 16382297n;

let app: FastifyInstance;
let db: Client;

beforeAll(async () => {
  db = new Client({ connectionString: DATABASE_URL });
  await db.connect();
  await runMigrations(db);
  app = await buildServer();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.end().catch(() => undefined);
});

describe("GET /v1/markets (live 31611)", () => {
  it("returns the two deployed series with live APYs, price and net carry spread", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/markets?chainId=31611" });
    expect(res.statusCode).toBe(200);

    const body = res.json() as {
      troveFixedBorrowAprBps: number;
      btcPriceUsd: string;
      series: Array<{
        seriesId: string;
        maturityTimestamp: number;
        ptTokenAddress: string;
        ytTokenAddress: string;
        fixedPtApyBps: number;
        impliedYtApyBps: number;
        activeAdapterMode: string;
        netCarrySpreadBps: number;
      }>;
    };

    // Trove borrow APR comes from Mezo's InterestRateManager (live: 100 bps = 1%).
    expect(body.troveFixedBorrowAprBps).toBe(100);
    expect(body.btcPriceUsd).toMatch(/^\d+\.\d{2}$/);
    expect(Number(body.btcPriceUsd)).toBeGreaterThan(1_000);

    expect(body.series).toHaveLength(2);
    const maturities = body.series.map((s) => s.maturityTimestamp).sort((a, b) => a - b);
    expect(maturities).toEqual([MATURITY_4W, MATURITY_12W]);

    for (const series of body.series) {
      expect(series.seriesId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(series.ptTokenAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(series.ytTokenAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(series.ptTokenAddress).not.toBe(series.ytTokenAddress);
      expect(series.fixedPtApyBps).toBeGreaterThan(0);
      expect(series.impliedYtApyBps).toBeGreaterThan(0);
      expect(["UNSTAKED_SMUSD", "GAUGE_STAKED_MEZO"]).toContain(series.activeAdapterMode);
      // netCarrySpreadBps = fixedPtApyBps - troveFixedBorrowAprBps
      expect(series.netCarrySpreadBps).toBe(
        series.fixedPtApyBps - body.troveFixedBorrowAprBps,
      );
    }
  });

  it("matches the values the frontend reads directly from chain (zero-backend parity)", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/markets?chainId=31611" });
    const body = res.json() as {
      series: Array<{ maturityTimestamp: number; fixedPtApyBps: number }>;
    };

    const clients = createMezoClients();
    const onChain = await fetchMarketsOnChain(clients.testnet, 31611);

    for (const series of body.series) {
      const direct = onChain.series.find(
        (s) => s.maturityTimestamp === series.maturityTimestamp,
      );
      expect(direct).toBeDefined();
      // APYs are price-derived and amount-independent, but the PT price decays with
      // block.timestamp, so two reads a block apart can differ by a bp or two.
      expect(Math.abs(series.fixedPtApyBps - direct!.fixedPtApyBps)).toBeLessThanOrEqual(2);
    }
  });

  it("upserts prism_series with a stable seriesId across calls", async () => {
    const first = await app.inject({ method: "GET", url: "/v1/markets?chainId=31611" });
    const second = await app.inject({ method: "GET", url: "/v1/markets?chainId=31611" });

    const ids = (r: typeof first) =>
      (r.json() as { series: Array<{ seriesId: string }> }).series.map((s) => s.seriesId);
    expect(ids(second).sort()).toEqual(ids(first).sort());

    const rows = await db.query<{
      maturity_timestamp: string;
      fixed_apy_bps: number;
      active_adapter_mode: string;
      is_matured: boolean;
    }>(
      `SELECT maturity_timestamp, fixed_apy_bps, active_adapter_mode, is_matured
         FROM prism_series WHERE chain_id = 31611 ORDER BY maturity_timestamp`,
    );
    expect(rows.rowCount).toBe(2);
    expect(rows.rows.map((r) => Number(r.maturity_timestamp))).toEqual([
      MATURITY_4W,
      MATURITY_12W,
    ]);
    for (const row of rows.rows) {
      expect(row.fixed_apy_bps).toBeGreaterThan(0);
      expect(row.active_adapter_mode).toBe("UNSTAKED_SMUSD");
      expect(row.is_matured).toBe(false);
    }
  });

  it("returns borrow APR and price but no series on 31612 (no Prism deployment)", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/markets?chainId=31612" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      troveFixedBorrowAprBps: number;
      btcPriceUsd: string;
      series: unknown[];
    };
    expect(body.btcPriceUsd).toMatch(/^\d+\.\d{2}$/);
    expect(body.series).toEqual([]);
  });

  it("rejects an unsupported chainId with 400", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/markets?chainId=1" });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { code: string; correlationId: string };
    expect(body.code).toBe("BadRequest");
    expect(body.correlationId).toBeTruthy();
  });
});

describe("GET /v1/positions/:address (live 31611)", () => {
  it("returns the deployer's live Trove, PT/YT balances, staked MEZO and discount", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/positions/${DEPLOYER}?chainId=31611`,
    });
    expect(res.statusCode).toBe(200);

    const body = res.json() as {
      userAddress: string;
      chainId: number;
      troveCollateralBtc: string;
      troveDebtMusd: string;
      troveIcrBps: number;
      ptBalance: string;
      ytBalance: string;
      stakedMezoBalance: string;
      feeDiscountBps: number;
    };

    expect(body.userAddress.toLowerCase()).toBe(DEPLOYER.toLowerCase());
    expect(body.chainId).toBe(31611);

    // Step 1.5 live E2E state: 50 MEZO staked (TIER_1 -> 1000 bps discount),
    // 20.027059843591451036 PT (4w), 510e18 YT (4w) + 500e18 YT (12w).
    expect(body.stakedMezoBalance).toBe("50");
    expect(body.feeDiscountBps).toBe(1000);
    expect(body.ptBalance).toBe("20.027059843591451036");
    expect(body.ytBalance).toBe("1010");

    // Live Trove: 0.048 BTC against ~2403.49 MUSD (ICR ~128.4%, drifts with interest).
    expect(Number(body.troveCollateralBtc)).toBeCloseTo(0.048, 6);
    expect(Number(body.troveDebtMusd)).toBeGreaterThan(2_000);
    expect(body.troveIcrBps).toBeGreaterThan(12_000);
    expect(body.troveIcrBps).toBeLessThan(13_000);
  });

  it("caches the portfolio into user_positions", async () => {
    await app.inject({ method: "GET", url: `/v1/positions/${DEPLOYER}?chainId=31611` });

    const row = await db.query<{
      staked_mezo_balance: string;
      fee_discount_bps: number;
      pt_balance: string;
      claimable_yield_musd: string;
      last_synced_block: string;
    }>(
      `SELECT staked_mezo_balance, fee_discount_bps, pt_balance,
              claimable_yield_musd, last_synced_block
         FROM user_positions WHERE user_address = $1 AND chain_id = 31611`,
      [DEPLOYER],
    );

    expect(row.rowCount).toBe(1);
    expect(Number(row.rows[0].staked_mezo_balance)).toBe(50);
    expect(row.rows[0].fee_discount_bps).toBe(1000);
    expect(Number(row.rows[0].pt_balance)).toBeCloseTo(20.027059843591451036, 12);
    // The deployer holds 500 YT of the 12-week series, so yield accrues over time
    // (M1's E2E claimed the 4-week series to zero).
    expect(Number(row.rows[0].claimable_yield_musd)).toBeGreaterThanOrEqual(0);
    expect(BigInt(row.rows[0].last_synced_block)).toBeGreaterThan(0n);
  });

  it("agrees with the direct SDK reader the frontend uses offline", async () => {
    const clients = createMezoClients();
    const direct = await fetchUserPortfolioOnChain(clients.testnet, 31611, DEPLOYER);

    const res = await app.inject({
      method: "GET",
      url: `/v1/positions/${DEPLOYER}?chainId=31611`,
    });
    const body = res.json() as { stakedMezoBalance: string; feeDiscountBps: number };

    expect(body.stakedMezoBalance).toBe(direct.stakedMezoBalance);
    expect(body.feeDiscountBps).toBe(direct.feeDiscountBps);
  });

  it("rejects a malformed address with 400", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/positions/0xdead" });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe("BadRequest");
  });
});

describe("getLogsChunked (R-017)", () => {
  it("splits a range into <= maxSpan windows with no gap or overlap", async () => {
    const calls: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
    const stub = {
      getLogs: async (params: { fromBlock: bigint; toBlock: bigint }) => {
        calls.push({ fromBlock: params.fromBlock, toBlock: params.toBlock });
        return [] as Log[];
      },
    };

    await getLogsChunked(
      stub as never,
      { address: "0x0000000000000000000000000000000000000001", fromBlock: 100n, toBlock: 20_099n },
      9_000n,
    );

    expect(calls).toEqual([
      { fromBlock: 100n, toBlock: 9_099n },
      { fromBlock: 9_100n, toBlock: 18_099n },
      { fromBlock: 18_100n, toBlock: 20_099n },
    ]);
    for (const call of calls) {
      expect(call.toBlock - call.fromBlock + 1n).toBeLessThanOrEqual(9_000n);
    }
  });
});

describe("MezoLogIndexerWorker", () => {
  it("indexes live 31611 chunks from the M1 E2E block and advances the checkpoint", async () => {
    // Deterministic start: an existing checkpoint row wins over `startBlocks`.
    await db.query(
      `INSERT INTO indexer_checkpoints (chain_id, last_indexed_block, updated_at)
       VALUES (31611, $1, NOW())
       ON CONFLICT (chain_id) DO UPDATE SET last_indexed_block = $1, updated_at = NOW()`,
      [(M1_E2E_FIRST_BLOCK - 1n).toString()],
    );

    const clients = createMezoClients();
    const worker = createIndexerWorker({
      db: pool,
      clients,
      chainIds: [31611],
      maxChunksPerRun: 1,
    });

    const summaries = await worker.runOnce();
    expect(summaries).toHaveLength(1);
    const [chunk] = summaries;
    expect(chunk.chainId).toBe(31611);
    expect(chunk.fromBlock).toBe(M1_E2E_FIRST_BLOCK);
    // R-017: never wider than the 9,000-block span.
    expect(chunk.toBlock - chunk.fromBlock + 1n).toBeLessThanOrEqual(DEFAULT_MAX_SPAN);
    expect(chunk.logs).toBeGreaterThan(0);
    expect(chunk.addresses).toBeGreaterThan(0);

    const checkpoint = await db.query<{ last_indexed_block: string }>(
      "SELECT last_indexed_block FROM indexer_checkpoints WHERE chain_id = 31611",
    );
    expect(checkpoint.rowCount).toBe(1);
    expect(BigInt(checkpoint.rows[0].last_indexed_block)).toBe(chunk.toBlock);

    const snapshots = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM yield_snapshots WHERE block_number = $1`,
      [chunk.toBlock.toString()],
    );
    expect(Number(snapshots.rows[0].count)).toBeGreaterThanOrEqual(1);

    const touched = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM user_positions
        WHERE chain_id = 31611 AND last_synced_block = $1`,
      [chunk.toBlock.toString()],
    );
    expect(Number(touched.rows[0].count)).toBeGreaterThan(0);
  }, 120_000);

  it("stops at the chain head and requests only <= maxSpan windows", async () => {
    // Deterministic start: the checkpoint row wins over `startBlocks` (by design).
    await db.query(
      `INSERT INTO indexer_checkpoints (chain_id, last_indexed_block, updated_at)
       VALUES (31611, 0, NOW())
       ON CONFLICT (chain_id) DO UPDATE SET last_indexed_block = 0, updated_at = NOW()`,
    );

    const requested: bigint[] = [];
    const stubClient = {
      getBlockNumber: async () => 10_000n,
      getLogs: async (params: { fromBlock: bigint; toBlock: bigint }) => {
        requested.push(params.toBlock - params.fromBlock + 1n);
        return [] as Log[];
      },
      multicall: async () => [],
    };

    const worker = createIndexerWorker({
      db: pool,
      clients: { testnet: stubClient as never, mainnet: stubClient as never },
      chainIds: [31611],
      startBlocks: { 31611: 0n },
      maxSpan: 4_000n,
      maxChunksPerRun: 10,
    });

    const summaries = await worker.runOnce();
    expect(summaries).toHaveLength(3);
    // checkpoint 0 -> first chunk starts at block 1, so windows end at 4000/8000/10000
    expect(summaries.map((s) => s.toBlock)).toEqual([4_000n, 8_000n, 10_000n]);
    expect(requested.every((span) => span <= 4_000n)).toBe(true);
  }, 60_000);
});
