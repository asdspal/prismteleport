import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import Redis from "ioredis";
import { DATABASE_URL, runMigrations } from "../src/db/migrate";

const TABLES = [
  "prism_series",
  "yield_snapshots",
  "teleport_intents",
  "relayer_transactions",
  "user_positions",
  "indexer_checkpoints",
];

const INDEXES = [
  "idx_prism_series_chain_maturity",
  "idx_yield_snapshots_series_time",
  "idx_teleport_intents_user",
  "idx_teleport_intents_status",
  "idx_relayer_tx_user",
  "idx_user_positions_chain",
];

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

let db: Client;

beforeAll(async () => {
  db = new Client({ connectionString: DATABASE_URL });
  await db.connect();
  await runMigrations(db);
});

afterAll(async () => {
  await db.end();
});

describe("PostgreSQL schema", () => {
  it("creates all six required tables", async () => {
    const result = await db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    const names = result.rows.map((row) => row.table_name);
    for (const table of TABLES) expect(names).toContain(table);
  });

  it("creates all six required indexes", async () => {
    const result = await db.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'public'",
    );
    const names = result.rows.map((row) => row.indexname);
    for (const index of INDEXES) expect(names).toContain(index);
  });

  it("rejects an invalid prism_series chain_id", async () => {
    await expect(
      db.query(
        `INSERT INTO prism_series (
          chain_id, maturity_timestamp, tokenizer_address, amm_address,
          pt_token_address, yt_token_address, initial_smusd_rate,
          smoothed_smusd_rate, active_adapter_mode
        ) VALUES (
          99999, 1, $1, $1, $1, $1, 1, 1, 'UNSTAKED_SMUSD'
        )`,
        ["0x0000000000000000000000000000000000000000"],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("is idempotent", async () => {
    expect(await runMigrations(db)).toEqual([]);
  });
});

describe("Redis", () => {
  it("responds to PING", async () => {
    const redis = new Redis(REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    await redis.connect();
    try {
      expect(await redis.ping()).toBe("PONG");
    } finally {
      await redis.quit();
    }
  });
});
