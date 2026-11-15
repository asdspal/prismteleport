import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  http,
  parseAbi,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Client } from "pg";
import { computeTroveHints } from "@prism-teleport/sdk";
import { runMigrations, DATABASE_URL } from "../src/db/migrate";

const ANVIL_RPC = "http://127.0.0.1:8546";
const FORK_URL = process.env.MEZO_TESTNET_RPC_URL ?? "https://rpc.test.mezo.org";

const ANVIL0_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const ANVIL1_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const ANVIL1 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const ANVIL2 = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;
const ANVIL3 = "0x90F79bf6EB2c4f870365E785982E1f101E93b906" as const;

const PRICE_FEED = "0x86bCF0841622a5dAC14A313a15f96A95421b9366" as const;
const BORROWER_OPS = "0xCdF7028ceAB81fA0C6971208e83fa7872994beE5" as const;
const BOS = "0xD757e3646AF370b15f32EB557F0F8380Df7D639e" as const;
const ROUTER = "0x7D536A4d33446d556CC8f6758ada141a17e0968b" as const;
const TOKENIZER = "0x7c2d76a696Fba9A12268f12d062AE04b7c4C20B3" as const;
const MUSD = "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503" as const;

/**
 * 0.15 BTC collateral (18-dec wei): at the mocked $100k price that opens at
 * 750% ICR (>= 110% MCR) and keeps 375% ICR after the 2,000 MUSD relayed
 * borrow (>= 150% router settle floor).
 */
const COLL = 150_000_000_000_000_000n; // 0.15 BTC
const OPEN_DEBT = 2_000_000_000_000_000_000_000n; // 2,000 MUSD (min net debt is 1,800)
const BORROW = 400_000_000_000_000_000_000n; // 400 MUSD: sized to the 12-week AMM pool's 500 PT reserve (swap reverts "insufficient pt" above it)
const RELAYER_FEE = 2_000_000_000_000_000_000n; // 2 MUSD (0.5% of borrow)
const MATURITY_FALLBACK = 17_998_848_000n;

const ERC20_ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
]);
const BOOTSTRAP_ABI = parseAbi([
  "function openTrove(uint256 debtAmount, address upperHint, address lowerHint) payable",
]);
const BOS_ABI = parseAbi([
  "function getNonce(address user) view returns (uint256)",
  "function withdrawMUSDWithSignature(uint256 amount, address upperHint, address lowerHint, address borrower, address recipient, bytes signature, uint256 deadline)",
]);
const ROUTER_VIEW_ABI = parseAbi([
  "function previewBorrowAndLock(address borrower, uint256 additionalMusdDebt, uint256 maturity) view returns (uint256 ptOut, uint256 newIcr, uint256 fixedApyBps)",
]);
const TOKENIZER_ABI = parseAbi([
  "function getActiveMaturities() view returns (uint256[])",
  "function getSeries(uint256 maturity) view returns ((uint256 maturity, address ptToken, address ytToken, uint256 totalPt, uint256 totalYt, uint256 rateAtInit, uint256 finalExchangeRate, bool finalized, uint256 finalAccMusdPerYt, uint256 finalAccMezoPerYt))",
]);
const ROUTER_RELAY_ABI = parseAbi([
  "function borrowAndLockFixedYield((address borrower,uint256 musdBorrowAmount,uint256 maturity,uint256 minPtOut,uint256 relayerFeeMusd,uint256 nonce,uint256 deadline,uint256 mezoDeadline,address upperHint,address lowerHint) params, bytes mezoSignature, bytes eip712Signature)",
]);

const RELAY_PATH = "/v1/relay/borrow-and-lock";
// Official formula says 245 trials for size ~265, but each trial is a remote
// trie read over anvil's sequential fork fetches (~1.2s each): 245 trials took
// 284s measured. 15 trials (the formula's floor) keeps setup sane and hints stay
// exact - findInsertPosition corrects from any approx seed.
const FORK_TRIALS = 15;
const EXPECTED_SELECTOR = toFunctionSelector(
  "borrowAndLockFixedYield((address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,address,address),bytes,bytes)",
);

const forkChain = defineChain({
  id: 31611,
  name: "Mezo Testnet Fork",
  nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: 18 },
  rpcUrls: { default: { http: [ANVIL_RPC] } },
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(ANVIL_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result;
}

let anvil: ChildProcess | undefined;
let anvilLogs = "";
let app: Awaited<ReturnType<typeof import("../src/server")["buildServer"]>>;
let pool: import("pg").Pool;
let forkPublic: ReturnType<typeof createPublicClient>;
let relayer: ReturnType<typeof privateKeyToAccount>;
let borrowerAccount: ReturnType<typeof privateKeyToAccount>;
let borrowerWallet: ReturnType<typeof createWalletClient>;
let maturity = MATURITY_FALLBACK;
let minPtOut = 0n;
let upperHint: Address = "0x0000000000000000000000000000000000000000";
let lowerHint: Address = "0x0000000000000000000000000000000000000000";
let baseBody: Record<string, unknown>;
let keyA = "";
let relayIdA = "";
let txHashA = "";
let relayerNonceAfterA = 0;

beforeAll(async () => {
  // Mezo blocks carry no excessBlobGas header field, so anvil needs the hardfork
// pinned: without it every eth_call fails with "Excess blob gas not set".
  // cancun matches Mezo's live execution (TLOAD/TSTORE confirmed on the testnet).
  anvil = spawn(
    "anvil",
    [
      "--fork-url",
      FORK_URL,
      "--port",
      "8546",
      "--hardfork",
      "cancun",
      "--silent",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  anvil.stderr?.on("data", (chunk) => {
    anvilLogs += String(chunk);
  });

  // wait for the fork
  const readyAt = Date.now() + 90_000;
  for (;;) {
    try {
      if ((await rpc("eth_chainId", [])) === "0x7b7b") break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > readyAt) {
      throw new Error(`anvil fork never became ready:\n${anvilLogs}`);
    }
    await sleep(250);
  }

  // Mezo's BTC price precompile does not exist under anvil: patch PriceFeed with a
  // stub whose fetchPrice() returns a fixed $100,000 for any selector.
  const price = (100_000n * 10n ** 18n).toString(16).padStart(64, "0");
  await rpc("anvil_setCode", [PRICE_FEED, `0x7f${price}60005260206000f3`]);

  // Point the relayer at the fork BEFORE any src/config import (dotenv never overrides).
  process.env.MEZO_TESTNET_RPC_URL = ANVIL_RPC;
  process.env.RELAYER_PRIVATE_KEY = ANVIL0_KEY;

  const [{ buildServer }, { pool: dbPool }] = await Promise.all([
    import("../src/server"),
    import("../src/db/pool"),
  ]);
  pool = dbPool;
  const migrateClient = new Client({ connectionString: DATABASE_URL });
  await migrateClient.connect();
  try {
    await runMigrations(migrateClient);
  } finally {
    await migrateClient.end();
  }

  // First calls stream trie state from the slow testnet RPC (~450ms/call RTT),
  // so the fork client waits far longer than viem's default 10s.
  forkPublic = createPublicClient({
    chain: forkChain,
    transport: http(ANVIL_RPC, { timeout: 240_000, retryCount: 1 }),
  });
  relayer = privateKeyToAccount(ANVIL0_KEY);
  borrowerAccount = privateKeyToAccount(ANVIL1_KEY);
  borrowerWallet = createWalletClient({
    account: borrowerAccount,
    chain: forkChain,
    transport: http(ANVIL_RPC),
  });

  // 1. borrower opens a real trove on the fork (test setup, not the relay under test)
  const openHints = await computeTroveHints(
    forkPublic,
    31611,
    COLL,
    OPEN_DEBT,
    undefined,
    FORK_TRIALS,
  );
  const openTx = await borrowerWallet.sendTransaction({
    account: borrowerAccount,
    chain: forkChain,
    to: BORROWER_OPS,
    data: encodeFunctionData({
      abi: BOOTSTRAP_ABI,
      functionName: "openTrove",
      args: [OPEN_DEBT, openHints.upperHint, openHints.lowerHint],
    }),
    value: COLL,
  });
  const openReceipt = await forkPublic.waitForTransactionReceipt({ hash: openTx });
  expect(openReceipt.status).toBe("success");

  // 2. active series + quote for minPtOut
  const active = (await forkPublic.readContract({
    address: TOKENIZER,
    abi: TOKENIZER_ABI,
    functionName: "getActiveMaturities",
  })) as readonly bigint[];
  expect(active.length).toBeGreaterThan(0);
  maturity = active[active.length - 1]!;

  const postHints = await computeTroveHints(
    forkPublic,
    31611,
    COLL,
    OPEN_DEBT + BORROW,
    undefined,
    FORK_TRIALS,
  );
  upperHint = postHints.upperHint;
  lowerHint = postHints.lowerHint;

  const preview = await forkPublic.readContract({
    address: ROUTER,
    abi: ROUTER_VIEW_ABI,
    functionName: "previewBorrowAndLock",
    args: [ANVIL1, BORROW, maturity],
  });
  minPtOut = (preview[0] * 99n) / 100n;
  expect(minPtOut).toBeGreaterThan(0n);

  // 3. both EIP-712 signatures (borrower signs Mezo WithdrawMUSD + Prism LockTerms)
  const now = Math.floor(Date.now() / 1000);
  const mezoDeadline = now + 3_600;
  const prismDeadline = now + 3_600;
  const mezoNonce = (await forkPublic.readContract({
    address: BOS,
    abi: BOS_ABI,
    functionName: "getNonce",
    args: [ANVIL1],
  })) as bigint;

  const mezoSig = await borrowerWallet.signTypedData({
    account: borrowerAccount,
    domain: {
      name: "BorrowerOperationsSignatures",
      version: "1",
      chainId: 31611,
      verifyingContract: BOS,
    },
    types: {
      WithdrawMUSD: [
        { name: "amount", type: "uint256" },
        { name: "borrower", type: "address" },
        { name: "recipient", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "WithdrawMUSD",
    message: {
      amount: BORROW,
      borrower: ANVIL1,
      recipient: ROUTER,
      nonce: mezoNonce,
      deadline: BigInt(mezoDeadline),
    },
  });

  const prismSig = await borrowerWallet.signTypedData({
    account: borrowerAccount,
    domain: {
      name: "PrismBorrowLockRouter",
      version: "1",
      chainId: 31611,
      verifyingContract: ROUTER,
    },
    types: {
      LockTerms: [
        { name: "borrower", type: "address" },
        { name: "musdBorrowAmount", type: "uint256" },
        { name: "maturity", type: "uint256" },
        { name: "minPtOut", type: "uint256" },
        { name: "relayerFeeMusd", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "LockTerms",
    message: {
      borrower: ANVIL1,
      musdBorrowAmount: BORROW,
      maturity,
      minPtOut,
      relayerFeeMusd: RELAYER_FEE,
      nonce: 1n,
      deadline: BigInt(prismDeadline),
    },
  });

  baseBody = {
    chainId: 31611,
    borrower: ANVIL1,
    musdBorrowAmountWei: BORROW.toString(),
    seriesMaturity: Number(maturity),
    minPtOutWei: minPtOut.toString(),
    upperHint,
    lowerHint,
    deadline: prismDeadline,
    relayerFeeMusd: RELAYER_FEE.toString(),
    nonce: 1,
    mezoDeadline,
    eip712Signature: prismSig,
    mezoBorrowSig: mezoSig,
  };

  // Warm the cold fork state through the exact relay call - if setup is wrong,
  // beforeAll fails here with the revert reason instead of a test timing out.
  const relayParams = {
    borrower: ANVIL1 as Address,
    musdBorrowAmount: BORROW,
    maturity,
    minPtOut,
    relayerFeeMusd: RELAYER_FEE,
    nonce: 1n,
    deadline: BigInt(prismDeadline),
    mezoDeadline: BigInt(mezoDeadline),
    upperHint,
    lowerHint,
  };
  await forkPublic.simulateContract({
    account: relayer,
    address: ROUTER,
    abi: ROUTER_RELAY_ABI,
    functionName: "borrowAndLockFixedYield",
    args: [relayParams, mezoSig as Hex, prismSig as Hex],
  });

  app = await buildServer();
}, 600_000);

afterAll(async () => {
  await app?.close();
  await pool?.end().catch(() => undefined);
  anvil?.kill("SIGTERM");
});

function inject(body: Record<string, unknown>, idempotencyKey: string) {
  return app.inject({
    method: "POST",
    url: RELAY_PATH,
    headers: { "idempotency-key": idempotencyKey },
    payload: body,
  });
}

async function musdBalance(address: Address): Promise<bigint> {
  return (await forkPublic.readContract({
    address: MUSD,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [address],
  })) as bigint;
}

describe("POST /v1/relay/borrow-and-lock on anvil 31611 fork", () => {
  it("(a) relays a valid gasless borrow-and-lock: 202, zero-custody settlement, CONFIRMED audit row", async () => {
    keyA = randomUUID();
    const relayerMusdBefore = await musdBalance(relayer.address);

    const res = await inject(baseBody, keyA);
    expect(res.statusCode).toBe(202);
    const accepted = res.json() as {
      relayId: string;
      txHash: string;
      status: string;
      explorerUrl: string;
    };
    relayIdA = accepted.relayId;
    txHashA = accepted.txHash;
    expect(accepted.status).toBe("SUBMITTED");
    expect(accepted.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(accepted.explorerUrl).toContain(accepted.txHash);

    // background receipt tracking flips the audit row to CONFIRMED (R-017)
    let row:
      | {
          status: string;
          function_selector: string;
          reimbursed_musd_wei: string;
          gas_used: string | null;
        }
      | undefined;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const res = await pool.query<{
        status: string;
        function_selector: string;
        reimbursed_musd_wei: string;
        gas_used: string | null;
      }>(
        `SELECT status, function_selector, reimbursed_musd_wei, gas_used
           FROM relayer_transactions WHERE relay_id = $1`,
        [relayIdA],
      );
      row = res.rows[0];
      if (row?.status === "CONFIRMED") break;
      await sleep(250);
    }
    expect(row?.status).toBe("CONFIRMED");
    expect(row?.function_selector).toBe(EXPECTED_SELECTOR);
    expect(row?.reimbursed_musd_wei).toBe(RELAYER_FEE.toString());
    expect(BigInt(row?.gas_used ?? "0")).toBeGreaterThan(0n);

    // value flow: relayer earned the MUSD fee, router kept zero dust, borrower got PT
    expect((await musdBalance(relayer.address)) - relayerMusdBefore).toBe(RELAYER_FEE);
    expect(await musdBalance(ROUTER)).toBe(0n);
    const series = await forkPublic.readContract({
      address: TOKENIZER,
      abi: TOKENIZER_ABI,
      functionName: "getSeries",
      args: [maturity],
    });
    const ptBalance = (await forkPublic.readContract({
      address: series.ptToken,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [ANVIL1],
    })) as bigint;
    expect(ptBalance).toBeGreaterThan(0n);

    relayerNonceAfterA = await forkPublic.getTransactionCount({
      address: relayer.address,
    });
  }, 300_000);

  it("(b) replays the same Idempotency-Key: 202 with the cached txHash, no double broadcast", async () => {
    const res = await inject(baseBody, keyA);
    expect(res.statusCode).toBe(202);
    const replay = res.json() as { relayId: string; txHash: string; status: string };
    expect(replay.relayId).toBe(relayIdA);
    expect(replay.txHash).toBe(txHashA);
    expect(replay.status).toBe("CONFIRMED");

    const nonceNow = await forkPublic.getTransactionCount({ address: relayer.address });
    expect(nonceNow).toBe(relayerNonceAfterA);

    const rows = await pool.query(
      "SELECT relay_id FROM relayer_transactions WHERE idempotency_key = $1",
      [keyA],
    );
    expect(rows.rowCount).toBe(1);
  }, 30_000);

  it("(c) STRIDE-04: simulation revert returns 422 with zero relayer gas spent", async () => {
    const keyC = randomUUID();
    const balanceBefore = await forkPublic.getBalance({ address: relayer.address });

    const res = await inject({ ...baseBody, deadline: 1 }, keyC);
    expect(res.statusCode).toBe(422);
    const body = res.json() as { code: string; message: string; correlationId: string };
    expect(body.code).toBe("SimulationReverted");
    expect(body.message).toContain("expired");
    expect(body.correlationId).toBeTruthy();

    expect(await forkPublic.getBalance({ address: relayer.address })).toBe(balanceBefore);
    const rows = await pool.query(
      "SELECT relay_id FROM relayer_transactions WHERE idempotency_key = $1",
      [keyC],
    );
    expect(rows.rowCount).toBe(0);
  }, 30_000);

  it("(d) GAP-005: EIP-7702 delegated borrower is blocked with 400 before simulation", async () => {
    await rpc("anvil_setCode", [ANVIL2, `0xef0100${ANVIL3.slice(2)}`]);
    const keyD = randomUUID();

    const res = await inject({ ...baseBody, borrower: ANVIL2 }, keyD);
    expect(res.statusCode).toBe(400);
    const body = res.json() as { code: string; correlationId: string };
    expect(body.code).toBe("EIP7702DelegationBlocked");
    expect(body.correlationId).toBeTruthy();

    const rows = await pool.query(
      "SELECT relay_id FROM relayer_transactions WHERE idempotency_key = $1",
      [keyD],
    );
    expect(rows.rowCount).toBe(0);
  }, 30_000);
});
