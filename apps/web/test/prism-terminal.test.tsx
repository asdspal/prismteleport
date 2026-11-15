// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { OneSignBorrowAndLockCard } from "@/components/prism/OneSignBorrowAndLockCard";
import { PtYtSwapAndMintCard } from "@/components/prism/PtYtSwapAndMintCard";
import { DualTrackAndFeeSimulatorCard } from "@/components/prism/DualTrackAndFeeSimulatorCard";
import type { MarketsView, PortfolioView } from "@/hooks/usePrismMarketsAndPortfolio";
import {
  adapterModeLabel,
  buildLockTermsTypedData,
  buildMezoWithdrawTypedData,
  buildRelayBody,
  MEZO_WITHDRAW_TYPES,
  MIN_NET_DEBT_MUSD,
  minOutWithSlippage,
  PRISM_LOCK_TYPES,
  PRISM_ADDRESSES,
  smusdSpotRate,
  smoothedVsSpotBps,
  validateBorrowAmount,
  ytLeverage,
} from "@/lib/prismTerminal";
import { parseAmount, quotePtOut, WAD } from "@/lib/carry";

/**
 * R-001..R-006, R-009, R-012..R-014: the terminal's EIP-712 payloads, relay
 * bodies, hint attachment, leverage preview and testnet simulator wiring.
 */

const writeContractAsync = vi.fn();
const signTypedDataAsync = vi.fn();
const readContracts = vi.fn();

vi.mock("wagmi", () => ({
  useAccount: () => ({ address: "0xfCe44470aC130E66849Aaa23F81D092066ff501E", isConnected: true }),
  useSignTypedData: () => ({ signTypedDataAsync }),
  useWriteContract: () => ({ writeContractAsync }),
  useReadContracts: () => ({ data: readContracts(), refetch: vi.fn() }),
}));

vi.mock("@prism-teleport/sdk", () => ({
  computeTroveHints: vi.fn(async () => ({
    upperHint: "0x2E1D793DEE32934a9b71087c09a1EFa5A9e4b6Cf",
    lowerHint: "0x187958091532733eF2f8703F8029Cd72aA85B2d4",
  })),
}));

const STUB_CLIENT = {
  readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
    functionName === "nonces" ? 6n : 0n,
  ),
  getBlock: vi.fn(async () => ({ timestamp: 1_794_716_013n })),
} as never;

const MARKETS: MarketsView = {
  troveFixedBorrowAprBps: 100,
  btcPriceUsd: "64201.30",
  series: [
    {
      maturityTimestamp: 1795046400,
      ptTokenAddress: "0x6e01091848b7a95265a161a0D9eE337eB91451bE",
      ytTokenAddress: "0x35DDd231fb5c565dB0c121917a068FCB3925F5e0",
      fixedPtApyBps: 489,
      impliedYtApyBps: 489,
      ptPriceWei: "999497130559328992",
      activeAdapterMode: "UNSTAKED_SMUSD",
      netCarrySpreadBps: 389,
    },
  ],
};

const PORTFOLIO: PortfolioView = {
  userAddress: "0xfCe44470aC130E66849Aaa23F81D092066ff501E",
  chainId: 31611,
  troveCollateralBtc: "0.048",
  troveDebtMusd: "2403.49",
  troveIcrBps: 12821,
  ptBalance: "20.027059843591451036",
  ytBalance: "1010",
  stakedMezoBalance: "50",
  feeDiscountBps: 1000,
};

beforeEach(() => {
  writeContractAsync.mockReset().mockResolvedValue("0xabc123def4567890abc123def4567890abc123def4567890abc123def4567890");
  signTypedDataAsync.mockReset().mockResolvedValue("0x" + "11".repeat(65));
  readContracts.mockReset().mockReturnValue([
    { result: 0n }, // activeMode = UNSTAKED_SMUSD
    { result: 0n }, // unstakedFeeAprBps
    { result: 500n }, // gaugeMezoAprBps
    { result: 1_010n * WAD }, // totalSmusdControlled
    { result: 0n }, // yieldIndex
    { result: WAD }, // smoothedExchangeRate
    { result: 50n }, // SWITCH_HYSTERESIS_BPS
  ]);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("EIP-712 payload construction", () => {
  it("builds the Mezo WithdrawMUSD payload the relayer and router verify", () => {
    const typed = buildMezoWithdrawTypedData(
      31611,
      PRISM_ADDRESSES[31611].borrowerOpsSignatures,
      {
        amount: parseAmount("2000"),
        borrower: "0xfCe44470aC130E66849Aaa23F81D092066ff501E",
        recipient: PRISM_ADDRESSES[31611].router,
        nonce: 6n,
        deadline: 1794719613n,
      },
    );

    expect(typed.domain).toEqual({
      name: "BorrowerOperationsSignatures",
      version: "1",
      chainId: 31611,
      verifyingContract: "0xD757e3646AF370b15f32EB557F0F8380Df7D639e",
    });
    expect(typed.primaryType).toBe("WithdrawMUSD");
    // The hints are deliberately NOT part of the signed struct.
    expect(MEZO_WITHDRAW_TYPES.WithdrawMUSD.map((field) => field.name)).toEqual([
      "amount",
      "borrower",
      "recipient",
      "nonce",
      "deadline",
    ]);
    expect(typed.message.recipient).toBe(PRISM_ADDRESSES[31611].router);
  });

  it("builds the Prism LockTerms payload in the router's exact field order", () => {
    const typed = buildLockTermsTypedData(31611, PRISM_ADDRESSES[31611].router, {
      borrower: "0xfCe44470aC130E66849Aaa23F81D092066ff501E",
      musdBorrowAmount: parseAmount("2000"),
      maturity: 1795046400n,
      minPtOut: parseAmount("1995"),
      relayerFeeMusd: parseAmount("2"),
      nonce: 1n,
      deadline: 1794719613n,
    });

    expect(typed.domain).toEqual({
      name: "PrismBorrowLockRouter",
      version: "1",
      chainId: 31611,
      verifyingContract: PRISM_ADDRESSES[31611].router,
    });
    expect(PRISM_LOCK_TYPES.LockTerms.map((field) => field.name)).toEqual([
      "borrower",
      "musdBorrowAmount",
      "maturity",
      "minPtOut",
      "relayerFeeMusd",
      "nonce",
      "deadline",
    ]);
  });

  it("builds the relayer body with hints, nonces and both signatures", () => {
    const body = buildRelayBody({
      chainId: 31611,
      borrower: "0xfCe44470aC130E66849Aaa23F81D092066ff501E",
      musdBorrowAmount: parseAmount("2000"),
      maturity: 1795046400,
      minPtOut: parseAmount("1995"),
      upperHint: "0x2E1D793DEE32934a9b71087c09a1EFa5A9e4b6Cf",
      lowerHint: "0x187958091532733eF2f8703F8029Cd72aA85B2d4",
      deadline: 1794719613,
      prismSignature: ("0x" + "22".repeat(65)) as `0x${string}`,
      mezoSignature: ("0x" + "33".repeat(65)) as `0x${string}`,
      relayerFeeMusd: parseAmount("2"),
      nonce: 1n,
      mezoDeadline: 1794719613,
    });

    expect(body.musdBorrowAmountWei).toBe("2000000000000000000000");
    expect(body.minPtOutWei).toBe("1995000000000000000000");
    expect(body.relayerFeeMusd).toBe("2000000000000000000");
    expect(body.nonce).toBe(1);
    expect(body.eip712Signature.startsWith("0x22")).toBe(true);
    expect(body.mezoBorrowSig.startsWith("0x33")).toBe(true);
  });
});

describe("terminal helpers", () => {
  it("enforces Mezo's 1,800 MUSD minimum only for an empty Trove", () => {
    expect(validateBorrowAmount(0n, parseAmount("1000"))).toEqual({
      ok: false,
      reason: "below-min-net-debt",
      minNetDebtMusd: "1800",
    });
    expect(validateBorrowAmount(0n, MIN_NET_DEBT_MUSD).ok).toBe(true);
    // An existing Trove may top up by any positive amount.
    expect(validateBorrowAmount(parseAmount("2403"), parseAmount("100")).ok).toBe(true);
    expect(validateBorrowAmount(0n, 0n)).toEqual({ ok: false, reason: "not-positive" });
  });

  it("applies the 1% slippage guard and the YT leverage math", () => {
    expect(minOutWithSlippage(parseAmount("2000"))).toBe(parseAmount("1980"));

    // 110 MUSD in, 100 YT out, 100 MUSD refunded => 10 MUSD of net cost for 100
    // of notional = 10x exposure.
    expect(ytLeverage(parseAmount("100"), parseAmount("110"), parseAmount("100"))).toBe(10);
    // At the live 4-day series the discount is ~0.05%, so the YT leg is far more
    // levered: notional / (musdIn - refund) with refund ~= 0.9995 * notional.
    const liveLeverage = ytLeverage(
      parseAmount("100"),
      parseAmount("100"),
      parseAmount("99.9497"),
    );
    expect(liveLeverage).toBeGreaterThan(1_000);
    expect(ytLeverage(0n, parseAmount("100"), 0n)).toBe(0);
  });

  it("labels adapter modes and compares smoothed vs spot rates", () => {
    expect(adapterModeLabel(0)).toBe("UNSTAKED_SMUSD");
    expect(adapterModeLabel(1)).toBe("GAUGE_STAKED_MEZO");
    expect(smusdSpotRate(0n)).toBe(WAD);
    expect(smusdSpotRate(parseAmount("0.05"))).toBe(WAD + parseAmount("0.05"));
    // smoothed 1.00 vs spot 1.00 => 0 bps; smoothed 1% higher => 100 bps
    expect(smoothedVsSpotBps(WAD, WAD)).toBe(0);
    expect(smoothedVsSpotBps(parseAmount("1.01"), WAD)).toBeCloseTo(100, 2);
  });
});

describe("OneSignBorrowAndLockCard", () => {
  it("attaches exact hints from /v1/hints and labels the gas saved", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(String(url)).toContain("/v1/hints?chainId=31611");
      expect(String(url)).toContain("collateralBtcWei=48000000000000000");
      expect(String(url)).toContain("debtMusdWei=4403490000000000000000");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          upperHint: "0x2E1D793DEE32934a9b71087c09a1EFa5A9e4b6Cf",
          lowerHint: "0x187958091532733eF2f8703F8029Cd72aA85B2d4",
        }),
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <OneSignBorrowAndLockCard
        markets={MARKETS}
        portfolio={PORTFOLIO}
        blockNumber={16_800_123}
        publicClient={STUB_CLIENT}
      />,
    );

    await waitFor(() => expect(screen.getByText(/Hints ready from \/v1\/hints/)).toBeDefined());
    expect(screen.getByText(/5.7M gas saved via HintHelpers/)).toBeDefined();
    expect(screen.getByText("API")).toBeDefined();
  });

  it("shows the 1,800 MUSD notice for a new Trove and offers the one-click fix", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ upperHint: "0x0000000000000000000000000000000000000001", lowerHint: "0x0000000000000000000000000000000000000002" }) }) as Response));

    render(
      <OneSignBorrowAndLockCard
        markets={MARKETS}
        portfolio={{ ...PORTFOLIO, troveDebtMusd: "0" }}
        publicClient={STUB_CLIENT}
      />,
    );

    fireEvent.change(screen.getByDisplayValue("2000"), { target: { value: "500" } });

    await waitFor(() =>
      expect(screen.getByText(/Mezo requires a 1800 MUSD minimum/)).toBeDefined(),
    );
    const fix = screen.getByText("Set to 1800 MUSD");
    fireEvent.click(fix);
    expect(screen.getByDisplayValue("1800")).toBeDefined();
  });

  it("submits gaslessly through the relayer with both signatures and an idempotency key", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/v1/hints")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            upperHint: "0x2E1D793DEE32934a9b71087c09a1EFa5A9e4b6Cf",
            lowerHint: "0x187958091532733eF2f8703F8029Cd72aA85B2d4",
          }),
        } as Response;
      }
      return {
        ok: true,
        status: 202,
        json: async () => ({
          relayId: "8f1e5b6a-0000-4000-8000-000000000001",
          txHash: "0x" + "aa".repeat(32),
          status: "SUBMITTED",
        }),
      } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <OneSignBorrowAndLockCard
        markets={MARKETS}
        portfolio={PORTFOLIO}
        publicClient={STUB_CLIENT}
      />,
    );
    await waitFor(() => expect(screen.getByText(/Hints ready/)).toBeDefined());

    fireEvent.click(screen.getByText(/Sign once · relayer locks it/));

    await waitFor(() => expect(screen.getByText(/Relayed without spending BTC gas/)).toBeDefined());
    expect(signTypedDataAsync).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/Track on Mezo explorer/)).toBeDefined();

    const relayCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/v1/relay/"));
    expect(relayCall).toBeDefined();
    const init = relayCall![1] as RequestInit;
    expect((init.headers as Record<string, string>)["idempotency-key"]).toBeTruthy();
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.musdBorrowAmountWei).toBe("2000000000000000000000");
    expect(body.upperHint).toBe("0x2E1D793DEE32934a9b71087c09a1EFa5A9e4b6Cf");
    expect(String(body.eip712Signature)).toMatch(/^0x11/);
    expect(String(body.mezoBorrowSig)).toMatch(/^0x11/);
  });

  it("sends directly from the wallet when the user picks the direct path", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ upperHint: "0x0000000000000000000000000000000000000001", lowerHint: "0x0000000000000000000000000000000000000002" }) }) as Response));

    render(
      <OneSignBorrowAndLockCard
        markets={MARKETS}
        portfolio={PORTFOLIO}
        publicClient={STUB_CLIENT}
      />,
    );
    await waitFor(() => expect(screen.getByText(/Hints ready/)).toBeDefined());

    fireEvent.click(screen.getByText("Direct wallet tx"));
    fireEvent.click(screen.getByText(/Sign once · send directly/));

    await waitFor(() => expect(screen.getByText(/Direct lock confirmed/)).toBeDefined());
    expect(writeContractAsync).toHaveBeenCalledTimes(1);
    const call = writeContractAsync.mock.calls[0][0] as {
      functionName: string;
      args: unknown[];
    };
    expect(call.functionName).toBe("borrowAndLockFixedYield");
    expect(call.args).toHaveLength(3);
  });
});

describe("PtYtSwapAndMintCard", () => {
  it("previews the PT buy at the live price and the leveraged YT netting", () => {
    render(<PtYtSwapAndMintCard markets={MARKETS} portfolio={PORTFOLIO} />);

    expect(screen.getByText("PT / YT swap & mint")).toBeDefined();
    // 100 MUSD less the 5 bps swap fee at 0.9994971 => ~100.00 PT
    expect(screen.getByText(/100\.00\d\d PT/)).toBeDefined();
    expect(screen.getByText("0.999497")).toBeDefined();

    fireEvent.click(screen.getByText("Buy YT-sMUSD (leverage)"));
    expect(screen.getByText(/Flash-mint netting/)).toBeDefined();
    expect(screen.getByText(/YT keeps its full notional/)).toBeDefined();
  });

  it("swaps MUSD into PT through PrismYieldAMM with a 1% slippage floor", async () => {
    render(<PtYtSwapAndMintCard markets={MARKETS} portfolio={PORTFOLIO} />);

    fireEvent.click(screen.getByText("Swap MUSD → PT"));

    await waitFor(() => expect(writeContractAsync).toHaveBeenCalledTimes(1));
    const call = writeContractAsync.mock.calls[0][0] as {
      address: string;
      functionName: string;
      args: bigint[];
    };
    expect(call.address).toBe(PRISM_ADDRESSES[31611].amm);
    expect(call.functionName).toBe("swapExactMusdForPt");
    expect(call.args[0]).toBe(1795046400n);
    expect(call.args[1]).toBe(parseAmount("100"));
    // 1% slippage floor on the exact quote (net of the 5 bps swap fee)
    const quote = quotePtOut(parseAmount("100"), BigInt(MARKETS.series[0].ptPriceWei!));
    expect(call.args[2]).toBe(minOutWithSlippage(quote));
  });
});

describe("DualTrackAndFeeSimulatorCard", () => {
  it("renders the live adapter regime and labels the simulator as testnet-only", () => {
    render(<DualTrackAndFeeSimulatorCard />);

    expect(screen.getByText("UNSTAKED_SMUSD")).toBeDefined();
    expect(screen.getByText("5.00%")).toBeDefined(); // gauge MEZO APR
    expect(screen.getByText("1010.00 sMUSD")).toBeDefined();
    expect(screen.getByText(/\[TESTNET SIMULATOR\] Weekly sMUSD fee drop \(\+5 MUSD\)/)).toBeDefined();
  });

  it("approves MUSD then injects the weekly fee yield on click", async () => {
    render(<DualTrackAndFeeSimulatorCard />);

    fireEvent.click(screen.getByText(/\[TESTNET SIMULATOR\]/));

    await waitFor(() => expect(writeContractAsync).toHaveBeenCalledTimes(2));
    const [approveCall, injectCall] = writeContractAsync.mock.calls.map(
      (call) => call[0] as { address: string; functionName: string; args: unknown[] },
    );
    expect(approveCall.address).toBe(PRISM_ADDRESSES[31611].musd);
    expect(approveCall.functionName).toBe("approve");
    expect(approveCall.args[0]).toBe(PRISM_ADDRESSES[31611].feeInjector);
    expect(injectCall.address).toBe(PRISM_ADDRESSES[31611].feeInjector);
    expect(injectCall.functionName).toBe("injectWeeklyFeeYield");
    expect(injectCall.args[0]).toBe(5n * WAD);
  });

  it("triggers the permissionless dual-track rebalance", async () => {
    render(<DualTrackAndFeeSimulatorCard />);

    fireEvent.click(screen.getByText("Trigger permissionless dual-track rebalance"));

    await waitFor(() => expect(writeContractAsync).toHaveBeenCalledTimes(1));
    const call = writeContractAsync.mock.calls[0][0] as { address: string; functionName: string };
    expect(call.address).toBe(PRISM_ADDRESSES[31611].adapter);
    expect(call.functionName).toBe("evaluateAndSwitchMode");
  });
});
