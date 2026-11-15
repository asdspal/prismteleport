import { describe, expect, it } from "vitest";
import {
  approxHintTrials,
  computeNicr,
  computeTroveHints,
} from "@prism-teleport/sdk";
import { buildServer } from "../src/server";
import { hintsTestOnly } from "../src/routes/hints";

const CALLER = "http://localhost:8080";

function hintsUrl(params: Record<string, string | number>): string {
  const search = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)]),
  );
  return `${CALLER}/v1/hints?${search.toString()}`;
}

describe("computeNicr", () => {
  it("matches on-chain HintHelpers.computeNominalCR", () => {
    // Verified against 31611 computeNominalCR(5e16, 2e21) == 2.5e15
    expect(computeNicr(50_000_000_000_000_000n, 2_000_000_000_000_000_000_000n)).toBe(
      2_500_000_000_000_000n,
    );
    // computeNominalCR(1e18, 2000e18) == 5e16
    expect(computeNicr(1_000_000_000_000_000_000n, 2_000_000_000_000_000_000_000n)).toBe(
      50_000_000_000_000_000n,
    );
  });

  it("rejects zero debt and negative collateral", () => {
    expect(() => computeNicr(1n, 0n)).toThrow(RangeError);
    expect(() => computeNicr(-1n, 1n)).toThrow(RangeError);
  });
});

describe("approxHintTrials", () => {
  it("clamps to [15, 250] per Liquity/Mezo formula", () => {
    expect(approxHintTrials(0)).toBe(15);
    expect(approxHintTrials(1)).toBe(15); // ceil(15 * 1)
    expect(approxHintTrials(2)).toBe(22); // ceil(15 * sqrt(2)) = ceil(21.21)
    expect(approxHintTrials(4)).toBe(30); // ceil(15 * 2)
    expect(approxHintTrials(265)).toBe(245); // ceil(15 * sqrt(265)), live testnet size
    expect(approxHintTrials(1_000_000)).toBe(250);
  });
});

describe("GET /v1/hints validation", () => {
  it("returns 400 when params are missing", async () => {
    const app = await buildServer();
    try {
      const res = await app.inject({ method: "GET", url: "/v1/hints" });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("returns 400 on zero debt", async () => {
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: "GET",
        url: hintsUrl({
          chainId: 31611,
          collateralBtcWei: "10000000000000000",
          debtMusdWei: "0",
        }),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: expect.stringContaining("debtMusdWei") });
    } finally {
      await app.close();
    }
  });

  it("returns 400 on negative or non-integer values", async () => {
    const app = await buildServer();
    try {
      for (const debt of ["-1", "1.5", "1e18", "abc"]) {
        const res = await app.inject({
          method: "GET",
          url: hintsUrl({
            chainId: 31611,
            collateralBtcWei: "1000",
            debtMusdWei: debt,
          }),
        });
        expect(res.statusCode).toBe(400);
      }
    } finally {
      await app.close();
    }
  });

  it("returns 400 on unsupported chainId", async () => {
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: "GET",
        url: hintsUrl({
          chainId: 1,
          collateralBtcWei: "1000",
          debtMusdWei: "1000",
        }),
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

describe("GET /v1/hints live RPC", () => {
  it("resolves exact hints on Mezo Testnet (31611)", async () => {
    const app = await buildServer();
    try {
      const startedAt = Date.now();
      const res = await app.inject({
        method: "GET",
        url: hintsUrl({
          chainId: 31611,
          collateralBtcWei: "50000000000000000",
          debtMusdWei: "2000000000000000000000",
        }),
      });
      const elapsedMs = Date.now() - startedAt;

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({
        nicr: "2500000000000000",
        upperHint: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/),
        lowerHint: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/),
        estimatedGas: 590000,
      });
      // live testnet has 265 troves → real hints, not zero-address short circuit
      const zero = "0x0000000000000000000000000000000000000000";
      expect(body.upperHint !== zero || body.lowerHint !== zero).toBe(true);
      // Cold path: 3 sequential eth_calls (size → approx → insert) on the
      // public testnet RPC (~450ms/call). Redis makes repeats <50ms below.
      expect(elapsedMs).toBeLessThan(2_500);

      const cachedStartedAt = Date.now();
      const cachedRes = await app.inject({
        method: "GET",
        url: hintsUrl({
          chainId: 31611,
          collateralBtcWei: "50000000000000000",
          debtMusdWei: "2000000000000000000000",
        }),
      });
      expect(cachedRes.statusCode).toBe(200);
      expect(cachedRes.json()).toEqual(body);
      expect(Date.now() - cachedStartedAt).toBeLessThan(50);
    } finally {
      await app.close();
    }
  });

  it("resolves exact hints on Mezo Mainnet (31612)", async () => {
    const app = await buildServer();
    try {
      const res = await app.inject({
        method: "GET",
        url: hintsUrl({
          chainId: 31612,
          collateralBtcWei: "100000000000000000",
          debtMusdWei: "2000000000000000000000",
        }),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({
        nicr: "5000000000000000",
        upperHint: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/),
        lowerHint: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/),
        estimatedGas: 590000,
      });
    } finally {
      await app.close();
    }
  });

  it("returns zero hints when SortedTroves size <= 2 (unit, mocked client)", async () => {
    const fakeClient = {
      readContract: async () => 2n,
    } as never;

    const hints = await computeTroveHints(fakeClient, 31611, 1n, 2n);
    expect(hints.upperHint).toBe("0x0000000000000000000000000000000000000000");
    expect(hints.lowerHint).toBe("0x0000000000000000000000000000000000000000");
    expect(hints.nicr).toBe(computeNicr(1n, 2n));
  });
});

describe("hints parseQuery (unit)", () => {
  it("accepts the openapi happy path", () => {
    const parsed = hintsTestOnly.parseQuery({
      chainId: "31611",
      collateralBtcWei: "50000000000000000",
      debtMusdWei: "2000000000000000000000",
    });
    expect(parsed).toEqual({
      chainId: 31611,
      collateralBtcWei: 50_000_000_000_000_000n,
      debtMusdWei: 2_000_000_000_000_000_000_000n,
    });
  });
});
