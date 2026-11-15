/**
 * Live workflow verifier — drives the SAME modules the UI runs, headlessly.
 *
 * The point is to catch bugs in the app's own logic (payload building, argument
 * order, address constants, slippage math, permit encoding, relayer bodies)
 * against live Mezo Testnet 31611, without a browser. Anything that fails here
 * would have failed in the UI, only slower to diagnose.
 *
 * Run:
 *   pnpm --filter @prism-teleport/relayer exec tsx apps/web/scripts/verify-live.ts
 *   (or from apps/web: ../../node_modules/.bin/tsx scripts/verify-live.ts)
 *
 * Flags:
 *   --only=hints,markets,pt,mint,redeem,claim,stake,relay-negative,lock,direct,micro
 *   --spend=1            allow state-changing checks (default: read-only + negative)
 *   --fee-inject         include the sMUSD fee simulator (changes the demo rate)
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mezoTestnet } from "../src/lib/chains";
import {
  AMM_ABI,
  ERC20_ABI,
  ERC20_PERMIT_ABI,
  FEE_INJECTOR_ABI,
  FEE_STAKING_ABI,
  MEZO_TESTNET_TELEPORT_HUB,
  MEZO_TOKEN,
  PRISM_ADDRESSES,
  ROUTER_ABI,
  TELEPORT_HUB_ABI,
  TOKENIZER_ABI,
  buildLockTermsTypedData,
  buildMezoWithdrawTypedData,
  buildRelayBody,
  minOutWithSlippage,
  paddedGasLimit,
  pickFreshRouterNonce,
  readPermitDomain,
  splitSignature,
} from "../src/lib/prismTerminal";
import { formatMusd, parseAmount, quotePtOut } from "../src/lib/carry";
import { parseAbi } from "viem";

const TROVE_MANAGER = "0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0" as Address;
const TROVE_MANAGER_ABI = parseAbi(["function getTroveColl(address) view returns (uint256)"]);
const NONCES_ABI = parseAbi(["function getNonce(address) view returns (uint256)"]);

// ---------------------------------------------------------------------------
// env + clients
// ---------------------------------------------------------------------------

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = { ...process.env } as Record<string, string>;
  try {
    const raw = readFileSync(resolve(__dirname, "../../../.env"), "utf8");
    for (const line of raw.split("\n")) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (!match) continue;
      // .env values may be quoted (RELAYER_PRIVATE_KEY="0x…") and carry a
      // trailing comment; normalise before use.
      const value = match[2].trim().replace(/^["']|["']$/g, "").split(" #")[0].trim();
      if (!out[match[1]]) out[match[1]] = value;
    }
  } catch {
    /* .env is optional when the vars are exported */
  }
  return out;
}

const env = loadEnv();
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const only = args.find((a) => a.startsWith("--only="))?.slice(7)?.split(",");
const spend = flag("spend");

const key = env.RELAYER_PRIVATE_KEY as Hex | undefined;
if (!key) throw new Error("RELAYER_PRIVATE_KEY missing (export it or add it to .env)");
const account = privateKeyToAccount(key);
// The browser gets NEXT_PUBLIC_API_BASE_URL (normalised by the app); the verifier
// talks to the local relayer unless --api= says otherwise.
const api = (args.find((a) => a.startsWith("--api="))?.slice(6) ?? "http://localhost:8080").replace(/\/$/, "");
const addresses = PRISM_ADDRESSES[31611];
const MATURITY_12W = 1_799_884_800;

const publicClient = createPublicClient({ chain: mezoTestnet, transport: http() });
const wallet = createWalletClient({ account, chain: mezoTestnet, transport: http() });

const results: Array<{ name: string; ok: boolean; detail: string }> = [];

async function check(name: string, fn: () => Promise<string>) {
  if (only && !only.some((entry) => name.startsWith(entry))) return;
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log(`PASS  ${name} — ${detail}`);
  } catch (error) {
    const err = error as {
      name?: string;
      message?: string;
      shortMessage?: string;
      cause?: { name?: string; shortMessage?: string; message?: string };
    };
    console.log("  [debug]", JSON.stringify({
      name: err.name,
      cause: err.cause?.name,
      details: (error as { details?: string }).details,
      meta: (error as { metaMessages?: string[] }).metaMessages,
    }));
    const detail = [
      err.shortMessage,
      err.cause?.shortMessage,
      err.cause?.message,
      err.message,
    ]
      .filter(Boolean)
      .map((m) => String(m).split("\n")[0])
      .filter((m, i, all) => all.indexOf(m) === i)
      .join(" | ");
    results.push({ name, ok: false, detail });
    console.log(`FAIL  ${name} — ${detail}`);
  }
}

/** Every write goes through the EIP-7623 padding the UI must use too. */
async function write(params: {
  address: Address;
  abi: readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
}): Promise<Hex> {
  const estimate = await publicClient.estimateContractGas({
    account,
    chain: mezoTestnet,
    ...params,
  } as never);
  return wallet.writeContract({
    account,
    chain: mezoTestnet,
    gas: paddedGasLimit(estimate),
    ...params,
  } as never);
}

async function send(hash: Hex) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`tx reverted: ${hash}`);
  return receipt;
}

async function balanceOf(token: Address, who: Address) {
  return (await publicClient.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [who],
  })) as bigint;
}

async function main() {
  console.log(`verifier wallet ${account.address}  |  spend=${spend}  |  api=${api}\n`);

  // ---------------------------------------------------------------- read paths
  await check("hints.api", async () => {
    const response = await fetch(
      `${api}/v1/hints?chainId=31611&collateralBtcWei=48000000000000000&debtMusdWei=2403510000000000000000`,
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { upperHint: string; lowerHint: string; nicr: string };
    if (!/^0x[0-9a-fA-F]{40}$/.test(body.upperHint)) throw new Error("bad upperHint");
    return `nicr ${body.nicr}, hints ${body.upperHint.slice(0, 8)}…/${body.lowerHint.slice(0, 8)}…`;
  });

  await check("markets.api", async () => {
    const response = await fetch(`${api}/v1/markets?chainId=31611`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as {
      troveFixedBorrowAprBps: number;
      btcPriceUsd: string;
      series: Array<{ maturityTimestamp: number; fixedPtApyBps: number; ptPriceWei?: string; netCarrySpreadBps: number }>;
    };
    const twelve = body.series.find((s) => s.maturityTimestamp === MATURITY_12W);
    if (!twelve) throw new Error("12-week series missing");
    if (!twelve.ptPriceWei) throw new Error("ptPriceWei missing (the calculator needs it)");
    return `borrow ${body.troveFixedBorrowAprBps}bps, price $${body.btcPriceUsd}, 12w fixed ${twelve.fixedPtApyBps}bps, ptPrice ${twelve.ptPriceWei}`;
  });

  await check("positions.api", async () => {
    const response = await fetch(`${api}/v1/positions/${account.address}?chainId=31611`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as {
      troveIcrBps: number;
      ptBalance: string;
      stakedMezoBalance: string;
      feeDiscountBps: number;
    };
    return `icr ${body.troveIcrBps}bps, pt ${body.ptBalance}, staked ${body.stakedMezoBalance}, discount ${body.feeDiscountBps}`;
  });

  // ------------------------------------------------------- on-chain reads used by the UI
  const series = await publicClient.readContract({
    address: addresses.tokenizer,
    abi: TOKENIZER_ABI,
    functionName: "series",
    args: [BigInt(MATURITY_12W)],
  });
  const ptToken = series[1] as Address;
  const ytToken = series[2] as Address;

  await check("pool.depth", async () => {
    const pool = await publicClient.readContract({
      address: addresses.amm,
      abi: AMM_ABI,
      functionName: "getPool",
      args: [BigInt(MATURITY_12W)],
    });
    const reservePt = pool[3];
    const price = pool[6];
    if (reservePt === 0n) throw new Error("empty pool");
    return `reservePt ${formatMusd(reservePt, 2)}, ptPrice ${formatMusd(price, 6)}`;
  });

  await check("quote.matches.chain", async () => {
    // The UI's own quote helper vs the AMM's own view.
    const amount = parseAmount("100");
    const pool = await publicClient.readContract({
      address: addresses.amm,
      abi: AMM_ABI,
      functionName: "getPool",
      args: [BigInt(MATURITY_12W)],
    });
    const uiQuote = quotePtOut(amount, pool[6]);
    const minOut = minOutWithSlippage(uiQuote);
    if (uiQuote <= 0n) throw new Error("ui quote is zero");
    if (minOut >= uiQuote) throw new Error("slippage floor not below the quote");
    return `ui quote ${formatMusd(uiQuote, 4)} PT, 1% floor ${formatMusd(minOut, 4)} PT`;
  });

  // ------------------------------------------------------------------ writes
  if (spend) {
    await check("pt.swap", async () => {
      const amount = parseAmount("50");
      const pool = await publicClient.readContract({
        address: addresses.amm,
        abi: AMM_ABI,
        functionName: "getPool",
        args: [BigInt(MATURITY_12W)],
      });
      const minOut = minOutWithSlippage(quotePtOut(amount, pool[6]));
      const before = await balanceOf(ptToken, account.address);
      await send(await write({ address: addresses.musd, abi: ERC20_ABI, functionName: "approve", args: [addresses.amm, amount] }));
      const hash = await write({
        address: addresses.amm,
        abi: AMM_ABI,
        functionName: "swapExactMusdForPt",
        args: [BigInt(MATURITY_12W), amount, minOut, account.address],
      });
      await send(hash);
      const after = await balanceOf(ptToken, account.address);
      if (after <= before) throw new Error("no PT received");
      return `+${formatMusd(after - before, 4)} PT (${hash.slice(0, 12)}…)`;
    });

    await check("mint.ptyt", async () => {
      const amount = parseAmount("10");
      const ptBefore = await balanceOf(ptToken, account.address);
      const ytBefore = await balanceOf(ytToken, account.address);
      await send(await write({ address: addresses.musd, abi: ERC20_ABI, functionName: "approve", args: [addresses.tokenizer, amount] }));
      const hash = await write({
        address: addresses.tokenizer,
        abi: TOKENIZER_ABI,
        functionName: "mintPyFromMusd",
        args: [amount, BigInt(MATURITY_12W), account.address],
      });
      await send(hash);
      const ptGain = (await balanceOf(ptToken, account.address)) - ptBefore;
      const ytGain = (await balanceOf(ytToken, account.address)) - ytBefore;
      if (ptGain !== amount || ytGain !== amount) {
        throw new Error(`expected ${formatMusd(amount, 2)} of each, got ${formatMusd(ptGain, 2)}/${formatMusd(ytGain, 2)}`);
      }
      return `minted ${formatMusd(ptGain, 2)} PT + ${formatMusd(ytGain, 2)} YT`;
    });

    await check("claim.yield", async () => {
      const pending = (await publicClient.readContract({
        address: addresses.tokenizer,
        abi: TOKENIZER_ABI,
        functionName: "pendingYield",
        args: [BigInt(MATURITY_12W), account.address],
      })) as readonly bigint[];
      const musdBefore = await balanceOf(addresses.musd, account.address);
      const hash = await write({
        address: addresses.tokenizer,
        abi: TOKENIZER_ABI,
        functionName: "claimYield",
        args: [BigInt(MATURITY_12W), account.address],
      });
      await send(hash);
      const gained = (await balanceOf(addresses.musd, account.address)) - musdBefore;
      return `pending ${formatMusd(pending[0], 6)} MUSD -> claimed ${formatMusd(gained, 6)}`;
    });

    await check("stake.permit", async () => {
      const liquid = await balanceOf(MEZO_TOKEN, account.address);
      if (liquid === 0n) return "skipped: no liquid MEZO";
      const amount = liquid < parseAmount("1") ? liquid : parseAmount("1");
      const nonce = (await publicClient.readContract({
        address: MEZO_TOKEN,
        abi: ERC20_PERMIT_ABI,
        functionName: "nonces",
        args: [account.address],
      })) as bigint;
      const domain = await readPermitDomain(publicClient, MEZO_TOKEN);
      if (!domain) {
        return "skipped: MEZO exposes no EIP-2612 domain (the UI falls back to approve+stake)";
      }
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const signature = await account.signTypedData({
        domain: {
          name: domain.name,
          version: domain.version,
          chainId: domain.chainId,
          verifyingContract: domain.verifyingContract,
        },
        types: {
          Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        },
        primaryType: "Permit",
        message: {
          owner: account.address,
          spender: addresses.feeStaking,
          value: amount,
          nonce,
          deadline,
        },
      });
      const { v, r, s } = splitSignature(signature);
      const hash = await write({
        address: addresses.feeStaking,
        abi: FEE_STAKING_ABI,
        functionName: "stakeWithPermit",
        args: [amount, deadline, v, r, s],
      });
      await send(hash);
      const discount = (await publicClient.readContract({
        address: addresses.feeStaking,
        abi: FEE_STAKING_ABI,
        functionName: "getFeeDiscountBps",
        args: [account.address],
      })) as bigint;
      return `staked ${formatMusd(amount, 2)} MEZO via permit, discount now ${Number(discount) / 100}%`;
    });

    await check("relay.gasless.lock", async () => {
      const borrow = parseAmount("400");
      const fee = parseAmount("2");
      const pool = await publicClient.readContract({
        address: addresses.amm,
        abi: AMM_ABI,
        functionName: "getPool",
        args: [BigInt(MATURITY_12W)],
      });
      const minPtOut = minOutWithSlippage(quotePtOut(borrow - fee, pool[6]));
      const hints = (await (
        await fetch(
          `${api}/v1/hints?chainId=31611&collateralBtcWei=${await publicClient.readContract({
            address: TROVE_MANAGER,
            abi: TROVE_MANAGER_ABI,
            functionName: "getTroveColl",
            args: [account.address],
          })}&debtMusdWei=${parseAmount("2803.51")}`,
        )
      ).json()) as { upperHint: Address; lowerHint: Address };

      const block = await publicClient.getBlock();
      const deadline = block.timestamp + 3600n;
      const [mezoNonce, prismNonce] = await Promise.all([
        publicClient.readContract({
          address: addresses.borrowerOpsSignatures,
          abi: NONCES_ABI,
          functionName: "getNonce",
          args: [account.address],
        }),
        pickFreshRouterNonce(publicClient, addresses.router, account.address),
      ]);

      const mezoSig = await account.signTypedData(
        buildMezoWithdrawTypedData(31611, addresses.borrowerOpsSignatures, {
          amount: borrow,
          borrower: account.address,
          recipient: addresses.router,
          nonce: mezoNonce,
          deadline,
        }),
      );
      const prismSig = await account.signTypedData(
        buildLockTermsTypedData(31611, addresses.router, {
          borrower: account.address,
          musdBorrowAmount: borrow,
          maturity: BigInt(MATURITY_12W),
          minPtOut,
          relayerFeeMusd: fee,
          nonce: prismNonce,
          deadline,
        }),
      );

      const response = await fetch(`${api}/v1/relay/borrow-and-lock`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `verify-${Date.now()}`,
        },
        body: JSON.stringify(
          buildRelayBody({
            chainId: 31611,
            borrower: account.address,
            musdBorrowAmount: borrow,
            maturity: MATURITY_12W,
            minPtOut,
            upperHint: hints.upperHint,
            lowerHint: hints.lowerHint,
            deadline: Number(deadline),
            prismSignature: prismSig,
            mezoSignature: mezoSig,
            relayerFeeMusd: fee,
            nonce: prismNonce,
            mezoDeadline: Number(deadline),
          }),
        ),
      });
      const body = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${body.code ?? ""} ${body.message ?? ""}`);
      }
      return `202 ${body.status} ${String(body.txHash).slice(0, 12)}… (${body.relayId})`;
    });
  }

  // ------------------------------------------------------------------- report
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("failures:");
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    process.exitCode = 1;
  }
  if (!spend) console.log("\n(read-only run — pass --spend to exercise the write paths)");
}

main().catch((error) => {
  console.error("verifier crashed:", error);
  process.exitCode = 1;
});
