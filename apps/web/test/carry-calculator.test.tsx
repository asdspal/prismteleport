// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FixedCarryCalculator } from "@/components/calculator/FixedCarryCalculator";
import { BtcShockSimulator } from "@/components/calculator/BtcShockSimulator";
import type { MarketsView } from "@/hooks/usePrismMarketsAndPortfolio";
import {
  applyPriceShock,
  carryProfitMusd,
  computeIcrBps,
  debtAtMaturity,
  fixedApyBpsFromPtPrice,
  formatBps,
  icrBand,
  liquidationPriceUsdWei,
  netCarrySpreadBps,
  parseAmount,
  ptPriceFromFixedApyBps,
  quotePtOut,
  secondsToMaturity,
  swapFeeMusd,
  WAD,
} from "@/lib/carry";

/**
 * R-016 / R-022: the landing calculator must work with no wallet, quote the same
 * math the contracts execute, and block anything under the 150% ICR floor.
 */

const WAD18 = WAD;
const PRICE_4W = 999_497_130_559_328_992n; // live 31611 4-week PT price
const PRICE_12W = 991_881_826_565_103_327n; // live 31611 12-week PT price
const MATURITY_4W = 1795046400;
const MATURITY_12W = 1799884800;

// The live series sit close to maturity (Nov 19 and Dec 24, 2026), which is
// exactly why the fee-vs-horizon trade-off below is worth asserting.
const DAY = 86_400n;

afterEach(cleanup);

const MARKETS: MarketsView = {
  troveFixedBorrowAprBps: 100,
  btcPriceUsd: "64201.30",
  series: [
    {
      seriesId: "73388aef-1370-4104-a6cc-4f79e2e44b0c",
      maturityTimestamp: MATURITY_4W,
      ptTokenAddress: "0x6e01091848b7a95265a161a0D9eE337eB91451bE",
      ytTokenAddress: "0x35DDd231fb5c565dB0c121917a068FCB3925F5e0",
      fixedPtApyBps: 489,
      impliedYtApyBps: 489,
      ptPriceWei: PRICE_4W.toString(),
      activeAdapterMode: "UNSTAKED_SMUSD",
      netCarrySpreadBps: 389,
    },
  ],
};

describe("carry math (mirrors the deployed contracts)", () => {
  it("charges the same 5 bps swap fee as PrismYieldAMM._feeAmount", () => {
    const amount = parseAmount("2000");
    expect(swapFeeMusd(amount)).toBe((amount * 5n) / 10_000n);
    // A 10% staking discount truncates 4.5 bps to 4 bps, exactly like the contract.
    expect(swapFeeMusd(amount, 1000)).toBe((amount * 4n) / 10_000n);
    expect(swapFeeMusd(0n)).toBe(0n);
  });

  it("quotes PT out exactly as swapExactMusdForPt does", () => {
    const amount = parseAmount("2000");
    const net = amount - (amount * 5n) / 10_000n;
    expect(quotePtOut(amount, PRICE_4W)).toBe((net * WAD18) / PRICE_4W);
    // ~2,000.45 PT at the live price (a small premium: the PT trades just under par)
    expect(quotePtOut(amount, PRICE_4W)).toBeGreaterThan(amount);
  });

  it("inverts the AMM's fixed-APY formula and round-trips the live price", () => {
    const timeToMaturity = 20n * 86_400n;
    const price = ptPriceFromFixedApyBps(489, timeToMaturity);
    const apy = fixedApyBpsFromPtPrice(price, timeToMaturity);
    expect(apy).toBeGreaterThanOrEqual(488n);
    expect(apy).toBeLessThanOrEqual(489n);
  });

  it("computes the net carry spread and the profit at maturity", () => {
    const amount = parseAmount("2000");
    expect(netCarrySpreadBps(489, 100)).toBe(389);

    // 12-week series: ~39 days of a 0.82% PT discount beats the 5 bps swap fee
    // and 39 days of 1% borrow interest.
    const twelveWeek = 39n * DAY;
    const owed = debtAtMaturity(amount, 100, twelveWeek);
    expect(owed).toBeGreaterThan(amount); // simple interest accrues
    const profit = carryProfitMusd(amount, PRICE_12W, 500, 100, twelveWeek);
    expect(profit).toBeGreaterThan(0n);
    expect(Number(profit) / 1e18).toBeGreaterThan(5);
    expect(Number(profit) / 1e18).toBeLessThan(40);

    // Same trade with the 4-day series: the fixed 5 bps swap fee (1 MUSD on
    // 2,000) exceeds 4 days of carry, so the calculator reports no carry rather
    // than an invented positive number.
    const fourDay = 4n * DAY;
    expect(carryProfitMusd(amount, PRICE_4W, 489, 100, fourDay)).toBeLessThan(0n);
  });

  it("bands ICR exactly at the router's 150% floor", () => {
    expect(icrBand(14_999n)).toBe("blocked");
    expect(icrBand(15_000n)).toBe("caution");
    expect(icrBand(17_999n)).toBe("caution");
    expect(icrBand(18_000n)).toBe("safe");
  });

  it("computes ICR and the liquidation price from live inputs", () => {
    const collateral = parseAmount("0.05");
    const debt = parseAmount("2000");
    const price = parseAmount("64201.30");
    const icr = computeIcrBps(collateral, debt, price);
    // 0.05 BTC * $64,201.30 = $3,210.07 against $2,000 debt => ~160.5%
    expect(icr).toBeGreaterThan(15_900n);
    expect(icr).toBeLessThan(16_200n);

    const liquidation = liquidationPriceUsdWei(collateral, debt);
    // debt * 110% / 0.05 BTC = $44,000
    expect(liquidation).toBe(parseAmount("44000"));
    expect(applyPriceShock(price, -3000n)).toBeLessThan(price);
  });

  it("clamps zero and negative inputs instead of dividing by zero", () => {
    expect(parseAmount("")).toBe(0n);
    expect(parseAmount("-5")).toBe(0n);
    expect(parseAmount("abc")).toBe(0n);
    expect(quotePtOut(0n, PRICE_4W)).toBe(0n);
    expect(computeIcrBps(0n, 0n, PRICE_4W)).toBe(0n);
    expect(formatBps(389)).toBe("3.89%");
  });
});

describe("FixedCarryCalculator", () => {
  it("renders live on-chain figures with a block citation and no wallet", () => {
    render(<FixedCarryCalculator markets={MARKETS} blockNumber={16_800_123} />);

    expect(screen.getByText("Fixed carry spread calculator")).toBeDefined();
    expect(screen.getByText("1.00%")).toBeDefined(); // Trove borrow APR (100 bps)
    expect(screen.getByText("4.89%")).toBeDefined(); // PT fixed APY (489 bps)
    expect(screen.getByText("3.89%")).toBeDefined(); // net carry spread
    expect(screen.getByText(/block #16800123/)).toBeDefined();
    // 0.05 BTC against 2,000 MUSD is ~160% ICR: caution, not safe.
    expect(screen.getByText(/Caution \(150%–179%\)/)).toBeDefined();
  });

  it("blocks a lock whose post-borrow ICR falls under 150%", () => {
    render(<FixedCarryCalculator markets={MARKETS} blockNumber={16_800_123} />);

    fireEvent.change(screen.getByDisplayValue("0.05"), { target: { value: "0.01" } });

    expect(screen.getByText(/Blocked \(< 150%\)/)).toBeDefined();
    expect(screen.getByRole("alert").textContent).toContain(
      "requires a post-borrow ICR of at least 150%",
    );
  });

  it("asks for a borrow amount when the field is cleared", () => {
    render(<FixedCarryCalculator markets={MARKETS} blockNumber={16_800_123} />);

    fireEvent.change(screen.getByDisplayValue("2000"), { target: { value: "" } });

    expect(screen.getByText(/Enter a borrow amount/)).toBeDefined();
  });

  it("renders a loading state without market data (no crash)", () => {
    render(<FixedCarryCalculator />);
    expect(screen.getByText(/Loading live market data/)).toBeDefined();
  });
});

describe("BtcShockSimulator", () => {
  it("recomputes ICR on a -30% shock while PT par redemption is unchanged", () => {
    const collateral = parseAmount("0.05");
    const debt = parseAmount("2000");
    render(
      <BtcShockSimulator
        markets={MARKETS}
        collateralBtcWei={collateral}
        debtMusdWei={debt}
        ptOutWei={quotePtOut(debt, PRICE_4W)}
        blockNumber={16_800_123}
      />,
    );

    expect(screen.getByText("What if BTC moves?")).toBeDefined();
    expect(screen.getByText("-30%")).toBeDefined();

    const slider = screen.getByLabelText("BTC price move in percent");
    fireEvent.change(slider, { target: { value: "-40" } });

    // $64,201.30 * 0.6 = $38,520.78 against $2,000 debt on 0.05 BTC => ~96% ICR (blocked)
    const shockedPrice = applyPriceShock(parseAmount("64201.30"), -4000n);
    expect(Number(shockedPrice) / 1e18).toBeCloseTo(38520.78, 1);
    const shockedIcr = computeIcrBps(collateral, debt, shockedPrice);
    expect(icrBand(shockedIcr)).toBe("blocked");
    expect(screen.getByText("96.30%")).toBeDefined();

    // The par-redemption claim never changes with the shock.
    expect(screen.getByText(/redeems for exactly/)).toBeDefined();
    expect(screen.getByText("1.00 MUSD per PT")).toBeDefined();
  });

  it("shows the liquidation price and how far spot is from it", () => {
    render(
      <BtcShockSimulator
        markets={MARKETS}
        collateralBtcWei={parseAmount("0.05")}
        debtMusdWei={parseAmount("2000")}
        ptOutWei={quotePtOut(parseAmount("2000"), PRICE_4W)}
      />,
    );
    expect(screen.getByText("$44,000.00")).toBeDefined();
    expect(screen.getByText(/-31\.5% from spot/)).toBeDefined();
  });
});
