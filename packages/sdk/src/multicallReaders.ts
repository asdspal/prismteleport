import { formatUnits, parseAbi, type Address, type PublicClient } from "viem";

/**
 * Multicall3 readers shared by `apps/relayer` (the `/v1/markets` and
 * `/v1/positions/:address` routes) and `apps/web` (zero-backend fallback, R-016):
 * both read identical values straight from Mezo state in one RPC round trip per
 * batch, so the UI keeps working when the Fastify API is offline.
 */

/** Canonical Multicall3, deployed on Mezo Testnet (31611) and Mainnet (31612). */
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

export interface MezoReadContracts {
  troveManager: Address;
  priceFeed: Address;
  interestRateManager: Address;
  multicall3: Address;
  /** Prism stack — absent on a chain where Prism is not deployed (31612). */
  tokenizer?: Address;
  amm?: Address;
  adapter?: Address;
  feeStaking?: Address;
}

export const MEZO_READ_CONTRACTS: Record<number, MezoReadContracts> = {
  31611: {
    troveManager: "0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0",
    priceFeed: "0x86bCF0841622a5dAC14A313a15f96A95421b9366",
    interestRateManager: "0xD4D6c36A592A2c5e86035A6bca1d57747a567f37",
    multicall3: MULTICALL3,
    tokenizer: "0x7c2d76a696Fba9A12268f12d062AE04b7c4C20B3",
    amm: "0xa40D6d099c8e5e86841367Ed384EDD09859bA979",
    adapter: "0xF4E0D1C1dD0a4D9d9b5e855C02bde6CCFbc1CbA5",
    feeStaking: "0xE5E0905F3c0b084cDc9221cA44146A6B4bD143a7",
  },
  31612: {
    troveManager: "0x94AfB503dBca74aC3E4929BACEeDfCe19B93c193",
    priceFeed: "0xc5aC5A8892230E0A3e1c473881A2de7353fFcA88",
    interestRateManager: "0x4a453700d157717Fe02fB62E7700ED7845048285",
    multicall3: MULTICALL3,
  },
};

export type ActiveAdapterMode = "UNSTAKED_SMUSD" | "GAUGE_STAKED_MEZO";

export interface MarketSeries {
  maturityTimestamp: number;
  ptTokenAddress: Address;
  ytTokenAddress: Address;
  fixedPtApyBps: number;
  /** The AMM pool's implied annual rate in bps (the market's implied yield). */
  impliedYtApyBps: number;
  /** PT price in MUSD (WAD), i.e. what one PT costs today (redeems at 1 MUSD). */
  ptPriceWei: string;
  activeAdapterMode: ActiveAdapterMode;
  netCarrySpreadBps: number;
  /** Extra fields the indexer/route persist into `prism_series` (decimal strings). */
  rateAtInit: string;
  smoothedRate: string;
  totalSmusdLocked: string;
  isMatured: boolean;
}

export interface MarketsOnChain {
  troveFixedBorrowAprBps: number;
  btcPriceUsd: string;
  /** Prism deployment addresses (undefined on a chain without Prism). */
  tokenizerAddress?: Address;
  ammAddress?: Address;
  series: MarketSeries[];
  /** Extra fields the indexer/route persist into `yield_snapshots`. */
  unstakedFeeAprBps: number;
  gaugeMezoAprBps: number;
}

export interface UserPortfolioOnChain {
  userAddress: Address;
  chainId: number;
  troveCollateralBtc: string;
  troveDebtMusd: string;
  troveIcrBps: number;
  ptBalance: string;
  ytBalance: string;
  stakedMezoBalance: string;
  feeDiscountBps: number;
  /** Extra fields the route caches into `user_positions`. */
  claimableYieldMusd: string;
  claimableYieldMezo: string;
  lastSyncedBlock: number;
}

const CORE_ABI = parseAbi([
  "function interestRate() view returns (uint16)",
  "function fetchPrice() view returns (uint256)",
  "function getTroveColl(address) view returns (uint256)",
  "function getTroveDebt(address) view returns (uint256)",
  "function getCurrentICR(address, uint256) view returns (uint256)",
]);

const PRISM_ABI = parseAbi([
  "function getActiveMaturities() view returns (uint256[])",
  "function smoothedExchangeRate() view returns (uint256)",
  "function series(uint256) view returns (uint256 maturity, address ptToken, address ytToken, uint256 totalPt, uint256 totalYt, uint256 rateAtInit, uint256 finalExchangeRate, bool finalized, uint256 finalAccMusdPerYt, uint256 finalAccMezoPerYt)",
  "function pendingYield(uint256, address) view returns (uint256 pendingMusd, uint256 pendingMezo)",
  "function quoteBorrowAndLockSpread(uint256, uint256, uint256) view returns (uint256 ptOut, uint256 fixedApyBps, int256 netCarrySpreadBps)",
  "function getPool(uint256) view returns (address pt, address yt, uint256 reserveMusd, uint256 reservePt, uint256 totalLp, uint256 impliedRateWad, uint256 price)",
  "function activeMode() view returns (uint8)",
  "function totalSmusdControlled() view returns (uint256)",
  "function unstakedFeeAprBps() view returns (uint256)",
  "function gaugeMezoAprBps() view returns (uint256)",
  "function stakes(address) view returns (uint128 amount, uint64 lastStakeTimestamp, uint128 rewardDebt, uint128 claimableMusd)",
  "function getFeeDiscountBps(address) view returns (uint256)",
]);

const ERC20_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);

/**
 * Quote size for `quoteBorrowAndLockSpread`: `fixedApyBps` is derived from the PT
 * price and is amount-independent, so any positive probe amount returns the same
 * APY while the third argument supplies the Trove APR used for the net spread.
 */
const QUOTE_PROBE_MUSD = 1_000n * 10n ** 18n;

const WAD = 10n ** 18n;
const BPS = 10_000n;

interface BatchOptions {
  contracts?: Partial<MezoReadContracts>;
  /** Historical read (used by the indexer to snapshot a chunk boundary). */
  blockNumber?: bigint;
}

function resolveContracts(
  chainId: number,
  overrides?: Partial<MezoReadContracts>,
): MezoReadContracts {
  const base = MEZO_READ_CONTRACTS[chainId];
  if (!base) throw new Error(`no Mezo contract map for chainId ${chainId}`);
  return { ...base, ...overrides };
}

type MulticallResult = { status: "success"; result: unknown } | { status: "failure"; error: Error };

/** A single eth_call in a Multicall3 batch (typed loosely: results are unwrapped by index). */
interface ReadCall {
  address: Address;
  abi: readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
}

async function multicall(
  client: PublicClient,
  multicallAddress: Address,
  calls: ReadCall[],
  blockNumber?: bigint,
): Promise<MulticallResult[]> {
  return (await client.multicall({
    multicallAddress,
    blockNumber,
    allowFailure: true,
    contracts: calls as never,
  })) as MulticallResult[];
}

/** Unwraps a multicall result, turning a per-call failure into a thrown error. */
function ok(result: MulticallResult, label: string): unknown {
  if (result.status === "failure") {
    throw new Error(`multicall read failed for ${label}: ${result.error.message}`);
  }
  return result.result;
}

function num(value: unknown, label: string): number {
  return Number(BigInt(ok(value as MulticallResult, label) as bigint));
}

function big(value: unknown, label: string): bigint {
  return BigInt(ok(value as MulticallResult, label) as bigint);
}

/**
 * Reads the live fixed-income market state: Trove borrow APR, BTC/USD price and
 * every active PT/YT series with its fixed APY, implied YT APY, adapter mode and
 * net carry spread (fixed APY − Trove borrow APR).
 *
 * Two batches: the per-series reads depend on `getActiveMaturities()`.
 */
export async function fetchMarketsOnChain(
  client: PublicClient,
  chainId: number,
  options: BatchOptions = {},
): Promise<MarketsOnChain> {
  const c = resolveContracts(chainId, options.contracts);
  const blockNumber = options.blockNumber;

  const prismCalls: ReadCall[] =
    c.tokenizer && c.adapter
      ? [
          { address: c.tokenizer, abi: PRISM_ABI, functionName: "getActiveMaturities" },
          { address: c.tokenizer, abi: PRISM_ABI, functionName: "smoothedExchangeRate" },
          { address: c.adapter, abi: PRISM_ABI, functionName: "activeMode" },
          { address: c.adapter, abi: PRISM_ABI, functionName: "totalSmusdControlled" },
          { address: c.adapter, abi: PRISM_ABI, functionName: "unstakedFeeAprBps" },
          { address: c.adapter, abi: PRISM_ABI, functionName: "gaugeMezoAprBps" },
        ]
      : [];

  const batch1 = await multicall(
    client,
    c.multicall3,
    [
      { address: c.interestRateManager, abi: CORE_ABI, functionName: "interestRate" },
      { address: c.priceFeed, abi: CORE_ABI, functionName: "fetchPrice" },
      ...prismCalls,
    ],
    blockNumber,
  );

  const troveFixedBorrowAprBps = num(batch1[0], "interestRate");
  const btcPriceUsdWei = big(batch1[1], "fetchPrice");

  const base: MarketsOnChain = {
    troveFixedBorrowAprBps,
    btcPriceUsd: Number(formatUnits(btcPriceUsdWei, 18)).toFixed(2),
    tokenizerAddress: c.tokenizer,
    ammAddress: c.amm,
    series: [],
    unstakedFeeAprBps: 0,
    gaugeMezoAprBps: 0,
  };

  if (!c.tokenizer || !c.amm || !c.adapter) return base;

  const maturities = ok(batch1[2] as MulticallResult, "getActiveMaturities") as bigint[];
  const smoothedRateWei = big(batch1[3], "smoothedExchangeRate");
  const mode = num(batch1[4], "activeMode");
  const totalSmusdLockedWei = big(batch1[5], "totalSmusdControlled");

  base.unstakedFeeAprBps = num(batch1[6], "unstakedFeeAprBps");
  base.gaugeMezoAprBps = num(batch1[7], "gaugeMezoAprBps");
  base.series = [];

  if (maturities.length === 0) return base;

  const perSeries: ReadCall[] = maturities.flatMap((maturity) => [
    { address: c.tokenizer!, abi: PRISM_ABI, functionName: "series", args: [maturity] },
    {
      address: c.amm!,
      abi: PRISM_ABI,
      functionName: "quoteBorrowAndLockSpread",
      args: [maturity, QUOTE_PROBE_MUSD, BigInt(troveFixedBorrowAprBps)],
    },
    { address: c.amm!, abi: PRISM_ABI, functionName: "getPool", args: [maturity] },
  ]);

  const batch2 = await multicall(client, c.multicall3, perSeries, blockNumber);

  const activeAdapterMode: ActiveAdapterMode =
    mode === 1 ? "GAUGE_STAKED_MEZO" : "UNSTAKED_SMUSD";

  maturities.forEach((maturity, index) => {
    const seriesResult = ok(batch2[index * 3], `series(${maturity})`) as readonly unknown[];
    const quoteResult = ok(batch2[index * 3 + 1], `quote(${maturity})`) as readonly bigint[];
    const poolResult = ok(batch2[index * 3 + 2], `getPool(${maturity})`) as readonly unknown[];

    base.series.push({
      maturityTimestamp: Number(maturity),
      ptTokenAddress: seriesResult[1] as Address,
      ytTokenAddress: seriesResult[2] as Address,
      fixedPtApyBps: Number(quoteResult[1]),
      impliedYtApyBps: Number((BigInt(poolResult[5] as bigint) * BPS) / WAD),
      ptPriceWei: (poolResult[6] as bigint).toString(),
      activeAdapterMode,
      netCarrySpreadBps: Number(quoteResult[2]),
      rateAtInit: formatUnits(seriesResult[5] as bigint, 18),
      smoothedRate: formatUnits(smoothedRateWei, 18),
      totalSmusdLocked: formatUnits(totalSmusdLockedWei, 18),
      isMatured: (seriesResult[7] as boolean) || maturity <= BigInt(Math.floor(Date.now() / 1000)),
    });
  });

  return base;
}

/**
 * Reads a user's live portfolio: Trove collateral/debt/ICR, PT and YT balances
 * (summed across every active series), claimable yield, staked MEZO and the
 * fee-staking discount tier.
 *
 * Two batches: the per-series token reads depend on `getActiveMaturities()`.
 */
export async function fetchUserPortfolioOnChain(
  client: PublicClient,
  chainId: number,
  user: Address,
  options: BatchOptions = {},
): Promise<UserPortfolioOnChain> {
  const c = resolveContracts(chainId, options.contracts);
  const blockNumber = options.blockNumber;

  const optionalCalls: ReadCall[] = [];
  if (c.tokenizer) {
    optionalCalls.push({
      address: c.tokenizer,
      abi: PRISM_ABI,
      functionName: "getActiveMaturities",
    });
  }
  if (c.feeStaking) {
    optionalCalls.push(
      { address: c.feeStaking, abi: PRISM_ABI, functionName: "stakes", args: [user] },
      { address: c.feeStaking, abi: PRISM_ABI, functionName: "getFeeDiscountBps", args: [user] },
    );
  }

  const batch1 = await multicall(
    client,
    c.multicall3,
    [
      { address: c.troveManager, abi: CORE_ABI, functionName: "getTroveColl", args: [user] },
      { address: c.troveManager, abi: CORE_ABI, functionName: "getTroveDebt", args: [user] },
      { address: c.priceFeed, abi: CORE_ABI, functionName: "fetchPrice" },
      ...optionalCalls,
    ],
    blockNumber,
  );

  const collateral = big(batch1[0], "getTroveColl");
  const debt = big(batch1[1], "getTroveDebt");
  const price = big(batch1[2], "fetchPrice");

  const portfolio: UserPortfolioOnChain = {
    userAddress: user,
    chainId,
    troveCollateralBtc: formatUnits(collateral, 18),
    troveDebtMusd: formatUnits(debt, 18),
    troveIcrBps: 0,
    ptBalance: "0",
    ytBalance: "0",
    stakedMezoBalance: "0",
    feeDiscountBps: 0,
    claimableYieldMusd: "0",
    claimableYieldMezo: "0",
    lastSyncedBlock: Number(blockNumber ?? (await client.getBlockNumber())),
  };

  let nextIndex = 3;
  let maturities: bigint[] = [];
  if (c.tokenizer) {
    maturities = ok(batch1[nextIndex] as MulticallResult, "getActiveMaturities") as bigint[];
    nextIndex += 1;
  }
  if (c.tokenizer && c.feeStaking) {
    const stakeInfo = ok(batch1[nextIndex], "stakes") as readonly [bigint, bigint, bigint, bigint];
    portfolio.stakedMezoBalance = formatUnits(BigInt(stakeInfo[0]), 18);
    portfolio.feeDiscountBps = num(batch1[nextIndex + 1], "getFeeDiscountBps");
  }

  if (debt > 0n || collateral > 0n) {
    const icr = await client.readContract({
      address: c.troveManager,
      abi: CORE_ABI,
      functionName: "getCurrentICR",
      args: [user, price],
      blockNumber,
    });
    portfolio.troveIcrBps = Number((BigInt(icr) * BPS) / WAD);
  }

  if (!c.tokenizer || maturities.length === 0) return portfolio;

  const perSeries: unknown[] = [];
  for (const maturity of maturities) {
    const seriesResult = (await client.readContract({
      address: c.tokenizer,
      abi: PRISM_ABI,
      functionName: "series",
      args: [maturity],
      blockNumber,
    })) as readonly unknown[];
    const ptToken = seriesResult[1] as Address;
    const ytToken = seriesResult[2] as Address;

    const balances = await multicall(
      client,
      c.multicall3,
      [
        { address: ptToken, abi: ERC20_ABI, functionName: "balanceOf", args: [user] },
        { address: ytToken, abi: ERC20_ABI, functionName: "balanceOf", args: [user] },
        {
          address: c.tokenizer,
          abi: PRISM_ABI,
          functionName: "pendingYield",
          args: [maturity, user],
        },
      ],
      blockNumber,
    );
    perSeries.push(balances);
  }

  let pt = 0n;
  let yt = 0n;
  let claimableMusd = 0n;
  let claimableMezo = 0n;
  for (const entry of perSeries) {
    const balances = entry as MulticallResult[];
    pt += big(balances[0], "pt balanceOf");
    yt += big(balances[1], "yt balanceOf");
    const pending = ok(balances[2], "pendingYield") as readonly bigint[];
    claimableMusd += BigInt(pending[0]);
    claimableMezo += BigInt(pending[1]);
  }

  portfolio.ptBalance = formatUnits(pt, 18);
  portfolio.ytBalance = formatUnits(yt, 18);
  portfolio.claimableYieldMusd = formatUnits(claimableMusd, 18);
  portfolio.claimableYieldMezo = formatUnits(claimableMezo, 18);

  return portfolio;
}
