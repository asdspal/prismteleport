import { parseAbi, type Address, type Hex } from "viem";
import { WAD, BPS } from "@/lib/carry";

/**
 * Contract layer for the `/prism` terminal (R-001..R-006, R-009, R-012..R-014).
 *
 * Everything here is pure: typed-data payloads, relay bodies, quote math and the
 * Mezo minimum-debt validation. The cards only add wallet plumbing on top, which
 * keeps the EIP-712 shapes and the request payloads unit-testable without a
 * wallet or a chain.
 */

export const MEZO_TESTNET = 31611;
export const MEZO_MAINNET = 31612;

/** Live 31611 addresses (contracts/deployments/31611.json). */
export const PRISM_ADDRESSES = {
  31611: {
    router: "0x7D536A4d33446d556CC8f6758ada141a17e0968b" as Address,
    borrowerOpsSignatures: "0xD757e3646AF370b15f32EB557F0F8380Df7D639e" as Address,
    tokenizer: "0x7c2d76a696Fba9A12268f12d062AE04b7c4C20B3" as Address,
    amm: "0xa40D6d099c8e5e86841367Ed384EDD09859bA979" as Address,
    adapter: "0xF4E0D1C1dD0a4D9d9b5e855C02bde6CCFbc1CbA5" as Address,
    feeStaking: "0xE5E0905F3c0b084cDc9221cA44146A6B4bD143a7" as Address,
    feeInjector: "0xd0F748a45708E77bf00384ED1C0ACC2e968517c3" as Address,
    musd: "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503" as Address,
    smusd: "0xd0F748a45708E77bf00384ED1C0ACC2e968517c3" as Address,
  },
} as const;

/** Mezo requires 1,800 MUSD net debt to open a standalone Trove. */
export const MIN_NET_DEBT_MUSD = 1_800n * WAD;

export const ROUTER_ABI = parseAbi([
  "function borrowAndLockFixedYield((address borrower,uint256 musdBorrowAmount,uint256 maturity,uint256 minPtOut,uint256 relayerFeeMusd,uint256 nonce,uint256 deadline,uint256 mezoDeadline,address upperHint,address lowerHint) p, bytes mezoBorrowSig, bytes prismLockSig) returns (uint256 ptOut)",
  "function previewBorrowAndLock(address borrower, uint256 additionalMusdDebt, uint256 maturity) view returns (uint256 ptOut, uint256 newIcr, uint256 fixedApyBps)",
  "function nonces(address) view returns (uint256)",
  "function MIN_ICR_NORMAL() view returns (uint256)",
]);

export const BORROWER_OPS_SIGNATURES_ABI = parseAbi([
  "function nonces(address) view returns (uint256)",
]);

export const TOKENIZER_ABI = parseAbi([
  "function getActiveMaturities() view returns (uint256[])",
  "function series(uint256) view returns (uint256 maturity, address ptToken, address ytToken, uint256 totalPt, uint256 totalYt, uint256 rateAtInit, uint256 finalExchangeRate, bool finalized, uint256 finalAccMusdPerYt, uint256 finalAccMezoPerYt)",
  "function smoothedExchangeRate() view returns (uint256)",
  "function mintPyFromMusd(uint256 musdAmount, uint256 maturity, address receiver) returns (uint256)",
  "function mintPyFromSmusd(uint256 smusdAmount, uint256 maturity, address receiver) returns (uint256)",
  "function redeemPyBeforeMaturity(uint256 pyAmount, uint256 maturity, address receiver) returns (uint256, uint256)",
  "function redeemPtAfterMaturity(uint256 ptAmount, uint256 maturity, address receiver) returns (uint256)",
  "function claimYield(uint256 maturity, address receiver) returns (uint256, uint256)",
  "function pendingYield(uint256 maturity, address user) view returns (uint256 pendingMusd, uint256 pendingMezo)",
]);

export const AMM_ABI = parseAbi([
  "function swapExactMusdForPt(uint256 maturity, uint256 musdIn, uint256 minPtOut, address receiver) returns (uint256 ptOut)",
  "function swapExactMusdForYt(uint256 maturity, uint256 musdIn, uint256 minYtOut, address receiver) returns (uint256 ytOut)",
  "function previewSwapMusdForYt(uint256 maturity, uint256 musdIn, address user) view returns (uint256 ytOut, uint256 refundMusd, uint256 feeMusd)",
  "function quoteBorrowAndLockSpread(uint256 maturity, uint256 musdBorrowAmount, uint256 troveBorrowAprBps) view returns (uint256 ptOut, uint256 fixedApyBps, int256 netCarrySpreadBps)",
  "function ptPriceInMusd(uint256 maturity) view returns (uint256)",
]);

export const ADAPTER_ABI = parseAbi([
  "function activeMode() view returns (uint8)",
  "function evaluateAndSwitchMode() returns (uint8)",
  "function unstakedFeeAprBps() view returns (uint256)",
  "function gaugeMezoAprBps() view returns (uint256)",
  "function totalSmusdControlled() view returns (uint256)",
  "function SWITCH_HYSTERESIS_BPS() view returns (uint256)",
]);

export const SMUSD_ABI = parseAbi([
  "function yieldIndex() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function allowance(address, address) view returns (uint256)",
]);

export const FEE_INJECTOR_ABI = parseAbi([
  "function injectWeeklyFeeYield(uint256 musdAmount)",
  "function yieldPerShare() view returns (uint256)",
]);

/** MEZO staking + fee-rebate portal (R-010). */
export const FEE_STAKING_ABI = parseAbi([
  "function stake(uint256 amount)",
  "function stakeWithPermit(uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
  "function unstake(uint256 amount)",
  "function claimRewards() returns (uint256 amount)",
  "function pendingMusd(address user) view returns (uint256)",
  "function getFeeDiscountBps(address user) view returns (uint256)",
  "function stakes(address) view returns (uint128 amount, uint64 lastStakeTimestamp, uint128 rewardDebt, uint128 claimableMusd)",
  "function totalMezoStaked() view returns (uint256)",
  "function TIER_1() view returns (uint256)",
  "function TIER_2() view returns (uint256)",
  "function TIER_3() view returns (uint256)",
  "function DISCOUNT_1_BPS() view returns (uint256)",
  "function DISCOUNT_2_BPS() view returns (uint256)",
  "function DISCOUNT_3_BPS() view returns (uint256)",
  "function DISCOUNT_COOLDOWN() view returns (uint256)",
]);

/** MEZO is a Mezo precompile token; 18 decimals like the rest of the stack. */
export const MEZO_TOKEN = "0x7B7c000000000000000000000000000000000001" as Address;

export const ERC20_PERMIT_ABI = parseAbi([
  "function nonces(address) view returns (uint256)",
  "function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)",
]);

export const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function allowance(address, address) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

/** Live 31611 default the simulator button injects (M1 used 5 MUSD). */
export const DEFAULT_FEE_SIMULATION_MUSD = 5n * WAD;

// ---------------------------------------------------------------------------
// EIP-712 payloads (verified live against Mezo Testnet in Steps 2.1/2.3)
// ---------------------------------------------------------------------------

export const MEZO_WITHDRAW_TYPES = {
  WithdrawMUSD: [
    { name: "amount", type: "uint256" },
    { name: "borrower", type: "address" },
    { name: "recipient", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export const PRISM_LOCK_TYPES = {
  LockTerms: [
    { name: "borrower", type: "address" },
    { name: "musdBorrowAmount", type: "uint256" },
    { name: "maturity", type: "uint256" },
    { name: "minPtOut", type: "uint256" },
    { name: "relayerFeeMusd", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export function mezoWithdrawDomain(chainId: number, verifyingContract: Address) {
  return {
    name: "BorrowerOperationsSignatures",
    version: "1",
    chainId,
    verifyingContract,
  } as const;
}

export function prismLockDomain(chainId: number, verifyingContract: Address) {
  return {
    name: "PrismBorrowLockRouter",
    version: "1",
    chainId,
    verifyingContract,
  } as const;
}

export interface MezoWithdrawMessage {
  amount: bigint;
  borrower: Address;
  /** The router is the MUSD recipient: it locks the borrowed MUSD into PT. */
  recipient: Address;
  nonce: bigint;
  deadline: bigint;
}

export function buildMezoWithdrawTypedData(
  chainId: number,
  borrowerOpsSignatures: Address,
  message: MezoWithdrawMessage,
) {
  return {
    domain: mezoWithdrawDomain(chainId, borrowerOpsSignatures),
    types: MEZO_WITHDRAW_TYPES,
    primaryType: "WithdrawMUSD" as const,
    message,
  };
}

export interface LockTermsMessage {
  borrower: Address;
  musdBorrowAmount: bigint;
  maturity: bigint;
  minPtOut: bigint;
  relayerFeeMusd: bigint;
  nonce: bigint;
  deadline: bigint;
}

export function buildLockTermsTypedData(
  chainId: number,
  router: Address,
  message: LockTermsMessage,
) {
  return {
    domain: prismLockDomain(chainId, router),
    types: PRISM_LOCK_TYPES,
    primaryType: "LockTerms" as const,
    message,
  };
}

export interface RelayBorrowLockBody {
  chainId: number;
  borrower: Address;
  musdBorrowAmountWei: string;
  seriesMaturity: number;
  minPtOutWei: string;
  upperHint: Address;
  lowerHint: Address;
  deadline: number;
  eip712Signature: Hex;
  relayerFeeMusd: string;
  nonce: number;
  mezoDeadline: number;
  mezoBorrowSig: Hex;
}

/** Body for `POST /v1/relay/borrow-and-lock` (Step 2.3 implementation truth). */
export function buildRelayBody(args: {
  chainId: number;
  borrower: Address;
  musdBorrowAmount: bigint;
  maturity: number;
  minPtOut: bigint;
  upperHint: Address;
  lowerHint: Address;
  deadline: number;
  prismSignature: Hex;
  mezoSignature: Hex;
  relayerFeeMusd: bigint;
  nonce: bigint;
  mezoDeadline: number;
}): RelayBorrowLockBody {
  return {
    chainId: args.chainId,
    borrower: args.borrower,
    musdBorrowAmountWei: args.musdBorrowAmount.toString(),
    seriesMaturity: args.maturity,
    minPtOutWei: args.minPtOut.toString(),
    upperHint: args.upperHint,
    lowerHint: args.lowerHint,
    deadline: args.deadline,
    eip712Signature: args.prismSignature,
    relayerFeeMusd: args.relayerFeeMusd.toString(),
    nonce: Number(args.nonce),
    mezoDeadline: args.mezoDeadline,
    mezoBorrowSig: args.mezoSignature,
  };
}

// ---------------------------------------------------------------------------
// Validation and quote helpers
// ---------------------------------------------------------------------------

export type BorrowValidation =
  | { ok: true }
  | { ok: false; reason: "below-min-net-debt"; minNetDebtMusd: string }
  | { ok: false; reason: "not-positive" };

/**
 * Mezo rejects a borrow that would leave a Trove below the 1,800 MUSD net-debt
 * floor; the notice (Issue 1) only applies when the Trove is empty, because an
 * existing Trove can borrow any amount above dust.
 */
export function validateBorrowAmount(
  existingDebtWei: bigint,
  borrowWei: bigint,
  minNetDebtWei: bigint = MIN_NET_DEBT_MUSD,
): BorrowValidation {
  if (borrowWei <= 0n) return { ok: false, reason: "not-positive" };
  if (existingDebtWei === 0n && borrowWei < minNetDebtWei) {
    return {
      ok: false,
      reason: "below-min-net-debt",
      minNetDebtMusd: (minNetDebtWei / WAD).toString(),
    };
  }
  return { ok: true };
}

/**
 * YT leverage: notional YT received per unit of *net* MUSD cost, where the cost
 * is what the swap does not refund as MUSD (`previewSwapMusdForYt`).
 */
export function ytLeverage(
  ytOutWei: bigint,
  musdInWei: bigint,
  refundMusdWei: bigint,
): number {
  const netCost = musdInWei - refundMusdWei;
  if (netCost <= 0n || ytOutWei <= 0n) return 0;
  // Two decimals: notional per 1 MUSD of net cost.
  return Number((ytOutWei * 100n) / netCost) / 100;
}

/** Slippage-protected minimum out (default 1%). */
export function minOutWithSlippage(quotedWei: bigint, slippageBps = 100n): bigint {
  return (quotedWei * (BPS - slippageBps)) / BPS;
}

/** sMUSD spot rate: `1e18 + yieldIndex` (what a sMUSD share is worth in MUSD). */
export function smusdSpotRate(yieldIndexWei: bigint): bigint {
  return WAD + yieldIndexWei;
}

/** Basis-point gap between the smoothed and the spot sMUSD rate. */
export function smoothedVsSpotBps(smoothedWei: bigint, spotWei: bigint): number {
  if (spotWei <= 0n) return 0;
  return Number(((smoothedWei - spotWei) * BPS * 100n) / spotWei) / 100;
}

export function adapterModeLabel(mode: number | bigint): "UNSTAKED_SMUSD" | "GAUGE_STAKED_MEZO" {
  return Number(mode) === 1 ? "GAUGE_STAKED_MEZO" : "UNSTAKED_SMUSD";
}

/**
 * Wallets disagree on the EIP-2612 `v` value (`0/1` vs `27/28`); the precompile
 * verifier expects the classic `27/28`, so normalise before calling
 * `PrismFeeStaking.stakeWithPermit` (Step 3.4 risk).
 */
export function normalizeV(v: number | bigint): 27 | 28 {
  const value = Number(v);
  if (value === 0 || value === 1) return (value + 27) as 27 | 28;
  if (value === 27 || value === 28) return value as 27 | 28;
  throw new RangeError(`unexpected signature v value: ${value}`);
}

/** Splits a 65-byte signature into the `(v, r, s)` the permit path needs. */
export function splitSignature(signature: Hex): { v: 27 | 28; r: Hex; s: Hex } {
  const hex = signature.slice(2);
  if (hex.length !== 130) throw new RangeError("signature must be 65 bytes");
  return {
    r: `0x${hex.slice(0, 64)}` as Hex,
    s: `0x${hex.slice(64, 128)}` as Hex,
    v: normalizeV(Number.parseInt(hex.slice(128, 130), 16)),
  };
}

/** MEZO fee-discount tiers, matching PrismFeeStaking's constants. */
export const STAKE_TIERS = [
  { stakeMusd: "10", discountBps: 1_000, label: "10 MEZO → 10% off" },
  { stakeMusd: "100", discountBps: 2_500, label: "100 MEZO → 25% off" },
  { stakeMusd: "500", discountBps: 5_000, label: "500 MEZO → 50% off" },
] as const;

/** Prohibited jurisdictions the compliance attestation covers (R-023). */
export const PROHIBITED_JURISDICTIONS = [
  "North Korea (KP)",
  "Cuba (CU)",
  "Iran (IR)",
  "Iraq (IQ)",
  "China (CN)",
  "Syria (SY)",
  "Crimea, Donetsk and Luhansk regions",
] as const;

/** Remaining flash-stake guard time as `"XXm XXs"` (STRIDE-03). */
export function formatCooldown(
  lastStakeTimestamp: number | bigint,
  nowSeconds: number,
  cooldownSeconds = 3_600,
): string | undefined {
  const remaining = Number(lastStakeTimestamp) + cooldownSeconds - nowSeconds;
  if (remaining <= 0) return undefined;
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

export const EXPLORER_TX_URL = (hash: string) =>
  `https://explorer.test.mezo.org/tx/${hash}`;

/** Gas the HintHelpers lookup saves on a borrow (Step 2.1 measurement). */
export const HINTS_GAS_SAVED = "~5.7M gas saved via HintHelpers";
