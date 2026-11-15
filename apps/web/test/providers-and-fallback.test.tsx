// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { JudgeModeProvider, useJudgeMode, DEMO_BORROWER } from "@/providers/judgeMode";
import {
  usePrismMarketsAndPortfolio,
  type MarketsView,
  type PortfolioView,
} from "@/hooks/usePrismMarketsAndPortfolio";

/**
 * R-015 / R-016 / R-017: the terminal must keep working when the Fastify API is
 * stopped (direct browser Multicall3 reads), and a judge must be able to inspect
 * the live Step 1.5 trove with no wallet at all.
 */

const MARKETS_API: MarketsView = {
  troveFixedBorrowAprBps: 100,
  btcPriceUsd: "64201.30",
  series: [
    {
      seriesId: "73388aef-1370-4104-a6cc-4f79e2e44b0c",
      maturityTimestamp: 1795046400,
      ptTokenAddress: "0x6e01091848b7a95265a161a0D9eE337eB91451bE",
      ytTokenAddress: "0x35DDd231fb5c565dB0c121917a068FCB3925F5e0",
      fixedPtApyBps: 489,
      impliedYtApyBps: 489,
      activeAdapterMode: "UNSTAKED_SMUSD",
      netCarrySpreadBps: 389,
    },
  ],
};

const POSITIONS_API: PortfolioView = {
  userAddress: DEMO_BORROWER,
  chainId: 31611,
  troveCollateralBtc: "0.048",
  troveDebtMusd: "2403.495229052666429888",
  troveIcrBps: 12821,
  ptBalance: "20.027059843591451036",
  ytBalance: "1010",
  stakedMezoBalance: "50",
  feeDiscountBps: 1000,
};

const onChainMarkets = vi.fn();
const onChainPortfolio = vi.fn();

vi.mock("@prism-teleport/sdk/multicallReaders", () => ({
  fetchMarketsOnChain: (...args: unknown[]) => onChainMarkets(...args),
  fetchUserPortfolioOnChain: (...args: unknown[]) => onChainPortfolio(...args),
}));

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const fakeClient = {} as never;

beforeEach(() => {
  onChainMarkets.mockReset();
  onChainPortfolio.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("usePrismMarketsAndPortfolio", () => {
  it("serves markets and positions from the API when it is reachable", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes("/v1/markets")
        ? jsonResponse(MARKETS_API)
        : jsonResponse(POSITIONS_API),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() =>
      usePrismMarketsAndPortfolio(DEMO_BORROWER, 31611, { publicClient: fakeClient }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.source).toBe("api");
    expect(result.current.markets?.series).toHaveLength(1);
    expect(result.current.markets?.series[0].fixedPtApyBps).toBe(489);
    expect(result.current.portfolio?.troveIcrBps).toBe(12821);
    expect(onChainMarkets).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to direct on-chain Multicall3 reads when the API is offline", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    onChainMarkets.mockResolvedValue({
      troveFixedBorrowAprBps: 100,
      btcPriceUsd: "64201.30",
      series: [
        {
          maturityTimestamp: 1795046400,
          ptTokenAddress: "0x6e01091848b7a95265a161a0D9eE337eB91451bE",
          ytTokenAddress: "0x35DDd231fb5c565dB0c121917a068FCB3925F5e0",
          fixedPtApyBps: 489,
          impliedYtApyBps: 489,
          activeAdapterMode: "UNSTAKED_SMUSD",
          netCarrySpreadBps: 389,
          rateAtInit: "1",
          smoothedRate: "1",
          totalSmusdLocked: "1010",
          isMatured: false,
        },
      ],
      unstakedFeeAprBps: 0,
      gaugeMezoAprBps: 0,
    });
    onChainPortfolio.mockResolvedValue({
      userAddress: DEMO_BORROWER,
      chainId: 31611,
      troveCollateralBtc: "0.048",
      troveDebtMusd: "2403.495229052666429888",
      troveIcrBps: 12821,
      ptBalance: "20.027059843591451036",
      ytBalance: "1010",
      stakedMezoBalance: "50",
      feeDiscountBps: 1000,
      claimableYieldMusd: "0",
      claimableYieldMezo: "0",
      lastSyncedBlock: 16_800_000,
    });

    const { result } = renderHook(() =>
      usePrismMarketsAndPortfolio(DEMO_BORROWER, 31611, { publicClient: fakeClient }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.source).toBe("onchain");
    expect(result.current.error).toBeUndefined();
    expect(result.current.markets?.series[0].netCarrySpreadBps).toBe(389);
    expect(result.current.portfolio?.stakedMezoBalance).toBe("50");
    expect(onChainMarkets).toHaveBeenCalledWith(fakeClient, 31611);
    expect(onChainPortfolio).toHaveBeenCalledWith(fakeClient, 31611, DEMO_BORROWER);
  });

  it("falls back on a 5xx API response too", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ code: "IndexerUnavailable" }, 500)),
    );
    onChainMarkets.mockResolvedValue({ ...MARKETS_API, series: [] });

    const { result } = renderHook(() =>
      usePrismMarketsAndPortfolio(undefined, 31611, { publicClient: fakeClient }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.source).toBe("onchain");
    expect(result.current.markets?.series).toEqual([]);
    expect(result.current.portfolio).toBeUndefined();
    // No address => no portfolio request at all.
    expect(onChainPortfolio).not.toHaveBeenCalled();
  });

  it("aborts an API request that exceeds the 2,500ms budget and reads on-chain", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            );
          }),
      ),
    );
    onChainMarkets.mockResolvedValue({ ...MARKETS_API, series: [] });

    const { result } = renderHook(() =>
      usePrismMarketsAndPortfolio(undefined, 31611, {
        publicClient: fakeClient,
        timeoutMs: 20,
      }),
    );

    await waitFor(() => expect(result.current.source).toBe("onchain"), {
      timeout: 2_000,
    });
    expect(result.current.loading).toBe(false);
    expect(onChainMarkets).toHaveBeenCalledTimes(1);
  });

  it("surfaces an error only when both the API and the on-chain read fail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    onChainMarkets.mockRejectedValue(new Error("RPC unreachable"));

    const { result } = renderHook(() =>
      usePrismMarketsAndPortfolio(undefined, 31611, { publicClient: fakeClient }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.markets).toBeUndefined();
    expect(result.current.error).toContain("fetch failed");
    expect(result.current.error).toContain("RPC unreachable");
  });
});

describe("Judge / Inspector mode (R-016)", () => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <JudgeModeProvider>{children}</JudgeModeProvider>
  );

  it("defaults to the connected wallet and switches to the demo trove", async () => {
    const connected = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
    const { result } = renderHook(() => useJudgeMode(), { wrapper });

    expect(result.current.judgeMode).toBe(false);
    expect(result.current.resolveActiveAddress(connected)).toBe(connected);

    act(() => result.current.toggleJudgeMode());

    expect(result.current.judgeMode).toBe(true);
    expect(result.current.resolveActiveAddress(connected)).toBe(DEMO_BORROWER);
    // The demo trove is readable with no wallet at all.
    expect(result.current.resolveActiveAddress(undefined)).toBe(DEMO_BORROWER);

    act(() => result.current.setJudgeMode(false));
    expect(result.current.resolveActiveAddress(undefined)).toBeUndefined();
  });

  it("keeps the demo address as the Step 1.5 live borrower", () => {
    expect(DEMO_BORROWER).toBe("0xfCe44470aC130E66849Aaa23F81D092066ff501E");
  });
});
