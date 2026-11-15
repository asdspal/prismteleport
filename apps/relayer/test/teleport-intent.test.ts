import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { DATABASE_URL, runMigrations } from "../src/db/migrate";
import { pool } from "../src/db/pool";
import {
  getTeleportIntent,
  relayTeleportIntent,
  TeleportHttpError,
  toHubIntent,
  type TeleportIntentBody,
} from "../src/services/teleportRelayer";
import { createTeleportWorker } from "../src/workers/teleportWorker";

/**
 * R-007, R-008, R-011, R-021, STRIDE-05: the teleport relayer's validation,
 * lifecycle persistence, hint attachment and rescue-escrow detection, plus the
 * status worker. Chain I/O is stubbed so the suite is hermetic.
 */

const HUB = "0x4992cE73548f42a4fc3C4685f965ea6C6d1AC401" as Address;
const BORROWER = "0xfCe44470aC130E66849Aaa23F81D092066ff501E" as Address;
const MEZO_TX = ("0x" + "ab".repeat(32)) as Hex;
const SOURCE_TX = ("0x" + "cd".repeat(32)) as Hex;

let db: Client;

beforeAll(async () => {
  db = new Client({ connectionString: DATABASE_URL });
  await db.connect();
  await runMigrations(db);
}, 60_000);

afterAll(async () => {
  await db?.end().catch(() => undefined);
  await pool.end().catch(() => undefined);
});

beforeEach(async () => {
  await db.query("DELETE FROM teleport_intents WHERE user_address = $1", [BORROWER]);
});

function body(overrides: Partial<TeleportIntentBody> = {}): TeleportIntentBody {
  return {
    sourceChainId: 84532,
    destChainId: 31611,
    userAddress: BORROWER,
    intentType: "BORROW_AND_LOCK_PT",
    collateralBtcWei: "50000000000000000",
    musdAmountWei: "2000000000000000000000",
    minOutputWei: "0",
    deadline: Math.floor(Date.now() / 1000) + 3_600,
    eip712Signature: ("0x" + "11".repeat(65)) as Hex,
    sourceTxHash: SOURCE_TX,
    seriesMaturity: 1_799_884_800,
    ...overrides,
  };
}

function deps(overrides: {
  rescued?: bigint;
  receiptStatus?: "success" | "reverted";
  writeThrows?: Error;
  sourceStatus?: "success" | "reverted";
} = {}) {
  const publicClient = {
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === "hashIntent") return ("0x" + "ef".repeat(32)) as Hex;
      if (functionName === "claimableRescueBtc") return overrides.rescued ?? 0n;
      return 0n;
    }),
    waitForTransactionReceipt: vi.fn(async () => ({ status: overrides.receiptStatus ?? "success" })),
    // The Mezo receipt: this is what the status worker reads.
    getTransactionReceipt: vi.fn(async () => ({ status: overrides.receiptStatus ?? "success" })),
    getBlockNumber: vi.fn(async () => 16_792_600n),
    multicall: vi.fn(async () => [
      { status: "success", result: 1n },
      { status: "success", result: BORROWER },
      { status: "success", result: BORROWER },
    ]),
  } as unknown as PublicClient;

  // Base is a different chain with its own client in production, so the source
  // receipt gets its own mock.
  const sourceClient = {
    getTransactionReceipt: vi.fn(async () => ({ status: overrides.sourceStatus ?? "success" })),
  } as unknown as PublicClient;

  const walletClient = {
    writeContract: vi.fn(async () => {
      if (overrides.writeThrows) throw overrides.writeThrows;
      return MEZO_TX;
    }),
  } as unknown as WalletClient;

  return {
    db: pool,
    publicClient,
    walletClient,
    hubAddress: HUB,
    relayerAddress: BORROWER,
    explorerBase: "https://explorer.test.mezo.org",
    sourceClient,
  };
}

describe("toHubIntent", () => {
  it("maps the API body onto the hub struct", () => {
    const intent = toHubIntent(body());
    expect(intent.borrower).toBe(BORROWER);
    expect(intent.intentType).toBe(0); // BORROW_AND_LOCK_PT
    expect(intent.collateralBtcWei).toBe(50_000_000_000_000_000n);
    expect(intent.musdAmountWei).toBe(2_000n * 10n ** 18n);
    expect(intent.seriesMaturity).toBe(1_799_884_800n);
    expect(intent.destChainId).toBe(31611n);
  });

  it("maps MICRO_TELEPORT to index 2", () => {
    expect(toHubIntent(body({ intentType: "MICRO_TELEPORT" })).intentType).toBe(2);
  });
});

describe("relayTeleportIntent", () => {
  it("relays, persists the lifecycle and returns the receipt", async () => {
    const receipt = await relayTeleportIntent(deps(), body());

    expect(receipt.status).toBe("COMPLETED");
    expect(receipt.mezoTxHash).toBe(MEZO_TX);
    expect(receipt.explorerUrl).toContain(MEZO_TX);

    const row = await db.query<{ status: string; mezo_tx_hash: string; source_tx_hash: string }>(
      "SELECT status, mezo_tx_hash, source_tx_hash FROM teleport_intents WHERE intent_hash = $1",
      [receipt.intentHash],
    );
    expect(row.rows[0].status).toBe("COMPLETED");
    expect(row.rows[0].mezo_tx_hash).toBe(MEZO_TX);
    expect(row.rows[0].source_tx_hash).toBe(SOURCE_TX);
  });

  it("flags the rescue escrow when the on-chain leg was caught (STRIDE-05)", async () => {
    const receipt = await relayTeleportIntent(deps({ rescued: 50_000_000_000_000_000n }), body());
    expect(receipt.status).toBe("RESCUED_ESCROW");
  });

  it("records FAILED and surfaces 422 when the relay write reverts", async () => {
    await expect(
      relayTeleportIntent(deps({ writeThrows: new Error("execution reverted") }), body()),
    ).rejects.toMatchObject({ status: 422, code: "RelayFailed" });

    const rows = await db.query<{ status: string; error_reason: string }>(
      "SELECT status, error_reason FROM teleport_intents WHERE user_address = $1",
      [BORROWER],
    );
    expect(rows.rows[0].status).toBe("FAILED");
    expect(rows.rows[0].error_reason).toContain("execution reverted");
  });

  it("rejects unsupported chains, expired deadlines and mislabelled micro borrows", async () => {
    await expect(
      relayTeleportIntent(deps(), body({ sourceChainId: 1 })),
    ).rejects.toBeInstanceOf(TeleportHttpError);

    await expect(
      relayTeleportIntent(deps(), body({ deadline: 1 })),
    ).rejects.toMatchObject({ code: "BadRequest" });

    // Under 1,800 MUSD without MICRO_TELEPORT: the UI must be explicit.
    await expect(
      relayTeleportIntent(deps(), body({ musdAmountWei: "25000000000000000000" })),
    ).rejects.toThrow(/MICRO_TELEPORT/);

    // The same size with the micro intent type is accepted.
    const receipt = await relayTeleportIntent(
      deps(),
      body({ intentType: "MICRO_TELEPORT", musdAmountWei: "25000000000000000000" }),
    );
    expect(receipt.status).toBe("COMPLETED");
  });

  it("waits for a pending source transaction instead of relaying blind", async () => {
    const pendingDeps = deps();
    (pendingDeps.sourceClient as unknown as { getTransactionReceipt: ReturnType<typeof vi.fn> }).getTransactionReceipt =
      vi.fn(async () => undefined);

    const receipt = await relayTeleportIntent(pendingDeps, body());
    // It still relays, but the row records that the source was not yet seen.
    expect(receipt.status).toBe("COMPLETED");
  });

  it("is idempotent for an already-relayed intent", async () => {
    const first = await relayTeleportIntent(deps(), body());
    const second = await relayTeleportIntent(deps(), body());
    expect(second.intentHash).toBe(first.intentHash);
    expect(second.mezoTxHash).toBe(first.mezoTxHash);
  });

  it("exposes the intent for the UI stepper", async () => {
    const receipt = await relayTeleportIntent(deps(), body());
    const fetched = await getTeleportIntent(pool, receipt.intentHash);
    expect(fetched?.status).toBe("COMPLETED");
    expect(fetched?.mezoTxHash).toBe(MEZO_TX);
    expect(await getTeleportIntent(pool, "0x" + "00".repeat(32))).toBeUndefined();
  });
});

describe("createTeleportWorker", () => {
  it("advances an EXECUTING_MEZO row to COMPLETED once the receipt lands", async () => {
    const receipt = await relayTeleportIntent(deps(), body());
    await db.query(
      "UPDATE teleport_intents SET status = 'EXECUTING_MEZO', mezo_tx_hash = NULL WHERE intent_hash = $1",
      [receipt.intentHash],
    );

    const worker = createTeleportWorker({
      db: pool,
      publicClient: deps().publicClient,
      hubAddress: HUB,
    });
    // No tx hash yet: the worker must leave it alone.
    expect((await worker.runOnce()).checked).toBe(1);

    await db.query("UPDATE teleport_intents SET mezo_tx_hash = $2 WHERE intent_hash = $1", [
      receipt.intentHash,
      MEZO_TX,
    ]);
    const summary = await worker.runOnce();
    expect(summary.completed).toBe(1);

    const row = await getTeleportIntent(pool, receipt.intentHash);
    expect(row?.status).toBe("COMPLETED");
  });

  it("marks a reverted Mezo transaction as FAILED", async () => {
    const receipt = await relayTeleportIntent(deps(), body());
    await db.query(
      "UPDATE teleport_intents SET status = 'EXECUTING_MEZO' WHERE intent_hash = $1",
      [receipt.intentHash],
    );

    const worker = createTeleportWorker({
      db: pool,
      publicClient: deps({ receiptStatus: "reverted" }).publicClient,
      hubAddress: HUB,
    });
    expect((await worker.runOnce()).failed).toBe(1);
    expect((await getTeleportIntent(pool, receipt.intentHash))?.status).toBe("FAILED");
  });
});
