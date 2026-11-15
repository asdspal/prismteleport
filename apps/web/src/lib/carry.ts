/**
 * Fixed-carry math for the read-only landing calculator (R-016, R-022).
 *
 * Every formula mirrors the deployed contracts exactly so the page can quote a
 * number and the transaction later matches it:
 * - `PrismYieldAMM._feeAmount` / `quoteBorrowAndLockSpread` (swap fee, PT out)
 * - `BorrowerOperations` simple-interest accrual for the debt at maturity
 * - Mezo `TroveManager` ICR (`collateral * price / debt`) and the MCR floor
 *
 * Pure BigInt wei/bps math: no floats, no hardcoded APYs. All live inputs come
 * from `GET /v1/markets` or the on-chain fallback.
 */

export const WAD = 10n ** 18n;
export const BPS = 10_000n;
export const SECONDS_PER_YEAR = 365n * 24n * 60n * 60n;
/** PrismYieldAMM.SWAP_FEE_BPS */
export const SWAP_FEE_BPS = 5n;
/** PrismYieldAMM clamps the discount horizon to [1 hour, 365 days]. */
export const MIN_TIME_TO_MATURITY = 60n * 60n;
export const MAX_TIME_TO_MATURITY = SECONDS_PER_YEAR;
/** Mezo MUSD minimum collateral ratio (110%). */
export const MEZO_MCR_BPS = 11_000n;
/** PrismBorrowLockRouter.MIN_ICR_NORMAL (150%). */
export const ROUTER_MIN_ICR_BPS = 15_000n;

export type IcrBand = "blocked" | "caution" | "safe";

/** Clamps the time to maturity exactly like `PrismYieldAMM`. */
export function clampTimeToMaturity(seconds: bigint): bigint {
  if (seconds < MIN_TIME_TO_MATURITY) return MIN_TIME_TO_MATURITY;
  if (seconds > MAX_TIME_TO_MATURITY) return MAX_TIME_TO_MATURITY;
  return seconds;
}

export function secondsToMaturity(maturityTimestamp: number, nowSeconds: number): bigint {
  const remaining = BigInt(maturityTimestamp) - BigInt(Math.floor(nowSeconds));
  return remaining > 0n ? clampTimeToMaturity(remaining) : 0n;
}

/**
 * `PrismYieldAMM._feeAmount` with the caller's fee-staking discount:
 * feeBps = SWAP_FEE_BPS * (BPS - discountBps) / BPS (integer division, as on chain).
 */
export function swapFeeBps(discountBps: number | bigint = 0n): bigint {
  const discount = BigInt(discountBps);
  const capped = discount > BPS ? BPS : discount < 0n ? 0n : discount;
  return (SWAP_FEE_BPS * (BPS - capped)) / BPS;
}

export function swapFeeMusd(amountWei: bigint, discountBps: number | bigint = 0n): bigint {
  if (amountWei <= 0n) return 0n;
  return (amountWei * swapFeeBps(discountBps)) / BPS;
}

/**
 * `PrismYieldAMM.swapExactMusdForPt`: net of the swap fee, converted at the PT
 * price (`ptOut = netMusd * WAD / price`).
 */
export function quotePtOut(
  musdBorrowWei: bigint,
  ptPriceWei: bigint,
  discountBps: number | bigint = 0n,
): bigint {
  if (musdBorrowWei <= 0n || ptPriceWei <= 0n) return 0n;
  const netMusd = musdBorrowWei - swapFeeMusd(musdBorrowWei, discountBps);
  return (netMusd * WAD) / ptPriceWei;
}

/**
 * PT price implied by a fixed APY: the exact inverse of
 * `PrismYieldAMM._fixedApyBps` (used to sanity-check the chain's price, and by
 * the shock simulator when only an APY is available).
 */
export function ptPriceFromFixedApyBps(
  fixedApyBps: number | bigint,
  timeToMaturitySeconds: bigint,
): bigint {
  const t = clampTimeToMaturity(timeToMaturitySeconds);
  const denominator = BPS * SECONDS_PER_YEAR + BigInt(fixedApyBps) * t;
  if (denominator <= 0n) return WAD;
  return (WAD * BPS * SECONDS_PER_YEAR) / denominator;
}

/** Annualized fixed APY of a PT bought at `price` (PrismYieldAMM._fixedApyBps). */
export function fixedApyBpsFromPtPrice(
  ptPriceWei: bigint,
  timeToMaturitySeconds: bigint,
): bigint {
  if (ptPriceWei >= WAD) return 0n;
  const t = clampTimeToMaturity(timeToMaturitySeconds);
  return ((WAD - ptPriceWei) * BPS * SECONDS_PER_YEAR) / (ptPriceWei * t);
}

/** Debt at maturity with Mezo's simple interest: debt * (1 + apr * t / year). */
export function debtAtMaturity(
  debtWei: bigint,
  borrowAprBps: number | bigint,
  timeToMaturitySeconds: bigint,
): bigint {
  const t = clampTimeToMaturity(timeToMaturitySeconds);
  const interest = (debtWei * BigInt(borrowAprBps) * t) / (BPS * SECONDS_PER_YEAR);
  return debtWei + interest;
}

/**
 * Guaranteed carry at maturity: PT redeems at par (1 MUSD each) while the debt
 * accrues at the Trove borrow APR.
 */
export function carryProfitMusd(
  musdBorrowWei: bigint,
  ptPriceWei: bigint,
  fixedApyBps: number | bigint,
  borrowAprBps: number | bigint,
  timeToMaturitySeconds: bigint,
  discountBps: number | bigint = 0n,
): bigint {
  const ptOut = quotePtOut(musdBorrowWei, ptPriceWei, discountBps);
  const owed = debtAtMaturity(musdBorrowWei, borrowAprBps, timeToMaturitySeconds);
  return ptOut - owed;
}

export function netCarrySpreadBps(
  fixedApyBps: number | bigint,
  borrowAprBps: number | bigint,
): number {
  return Number(BigInt(fixedApyBps) - BigInt(borrowAprBps));
}

/** Mezo ICR in bps: `collateral * price / debt`, both 18-decimal. */
export function computeIcrBps(
  collateralBtcWei: bigint,
  debtMusdWei: bigint,
  btcPriceUsdWei: bigint,
): bigint {
  if (debtMusdWei <= 0n || collateralBtcWei <= 0n) return 0n;
  return (collateralBtcWei * btcPriceUsdWei * BPS) / (debtMusdWei * WAD);
}

/** BTC price at which the Trove hits the Mezo MCR (its liquidation price). */
export function liquidationPriceUsdWei(
  collateralBtcWei: bigint,
  debtMusdWei: bigint,
  mcrBps: bigint = MEZO_MCR_BPS,
): bigint {
  if (collateralBtcWei <= 0n) return 0n;
  return (debtMusdWei * mcrBps * WAD) / (collateralBtcWei * BPS);
}

/** Safety bands the router enforces: blocked < 150% <= caution < 180% <= safe. */
export function icrBand(icrBps: bigint): IcrBand {
  if (icrBps < ROUTER_MIN_ICR_BPS) return "blocked";
  if (icrBps < 18_000n) return "caution";
  return "safe";
}

/** Applies a BTC price shock in bps (e.g. -3000n for -30%) to a price. */
export function applyPriceShock(priceWei: bigint, shockBps: bigint): bigint {
  const shocked = priceWei + (priceWei * shockBps) / BPS;
  return shocked > 0n ? shocked : 0n;
}

export function formatMusd(wei: bigint, decimals = 2): string {
  const negative = wei < 0n;
  const absolute = negative ? -wei : wei;
  const whole = absolute / WAD;
  const fraction = (absolute % WAD).toString().padStart(18, "0").slice(0, decimals);
  const sign = negative ? "-" : "";
  return decimals > 0 ? `${sign}${whole}.${fraction}` : `${sign}${whole}`;
}

export function formatBps(bps: number | bigint): string {
  return `${(Number(bps) / 100).toFixed(2)}%`;
}

export function formatBtc(wei: bigint, decimals = 4): string {
  const whole = wei / WAD;
  const fraction = (wei % WAD).toString().padStart(18, "0").slice(0, decimals);
  return decimals > 0 ? `${whole}.${fraction}` : `${whole}`;
}

export function formatUsd(wei: bigint): string {
  const whole = wei / WAD;
  const cents = ((wei % WAD) * 100n) / WAD;
  return `${whole.toLocaleString("en-US")}.${cents.toString().padStart(2, "0")}`;
}

/** Parses a user-typed decimal amount into wei, clamping negatives to zero. */
export function parseAmount(value: string, decimals = 18): bigint {
  const trimmed = value.trim();
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === "" || trimmed === ".") return 0n;
  const [whole, fraction = ""] = trimmed.split(".");
  const paddedFraction = fraction.slice(0, decimals).padEnd(decimals, "0");
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(paddedFraction || "0");
}
