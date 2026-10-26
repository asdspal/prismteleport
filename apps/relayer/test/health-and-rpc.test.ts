import { describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";
import {
  getLogsChunked,
  waitForReceiptResilient,
} from "../src/lib/mezoClient";
import { buildServer } from "../src/server";

describe("getLogsChunked", () => {
  it("splits [1000, 29000] into four windows of at most 9000 blocks", async () => {
    const calls: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
    const client = {
      getLogs: vi.fn(async (filter: { fromBlock: bigint; toBlock: bigint }) => {
        calls.push(filter);
        return [{ blockNumber: filter.fromBlock }];
      }),
    } as unknown as Pick<PublicClient, "getLogs">;

    const logs = await getLogsChunked(client, {
      fromBlock: 1000n,
      toBlock: 29000n,
    });

    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call.toBlock - call.fromBlock + 1n).toBeLessThanOrEqual(9000n);
    }
    expect(calls[0]).toEqual({ fromBlock: 1000n, toBlock: 9999n });
    expect(calls[3]).toEqual({ fromBlock: 28000n, toBlock: 29000n });
    expect(logs).toHaveLength(4);
  });
});

describe("waitForReceiptResilient", () => {
  it("retries null receipts and succeeds on the third attempt", async () => {
    const receipt = { transactionHash: `0x${"ab".repeat(32)}` };
    const getTransactionReceipt = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(receipt);
    const client = { getTransactionReceipt } as unknown as Pick<
      PublicClient,
      "getTransactionReceipt"
    >;

    const result = await waitForReceiptResilient(
      client,
      `0x${"ab".repeat(32)}`,
      5,
      1,
    );

    expect(result).toEqual(receipt);
    expect(getTransactionReceipt).toHaveBeenCalledTimes(3);
  });
});

describe("GET /v1/health", () => {
  it("returns live block heights and the relayer BTC balance", async () => {
    const app = await buildServer();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/health",
        headers: { "x-correlation-id": "test-correlation-id" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["x-correlation-id"]).toBe("test-correlation-id");

      const body = response.json();
      expect(body.status).toBe("ok");
      expect(Number.isInteger(body.mezoTestnetBlock)).toBe(true);
      expect(Number.isInteger(body.mezoMainnetBlock)).toBe(true);
      expect(body.mezoTestnetBlock).toBeGreaterThan(0);
      expect(body.mezoMainnetBlock).toBeGreaterThan(0);
      expect(typeof body.relayerGasBtc).toBe("string");
    } finally {
      await app.close();
    }
  });
});
