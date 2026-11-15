import { describe, expect, it, vi } from "vitest";
import {
  BORROWER_OPS_SIGNATURES_ABI,
  MEZO_TOKEN,
  paddedGasLimit,
  pickFreshRouterNonce,
  PRISM_ADDRESSES,
  readPermitDomain,
  ROUTER_ABI,
} from "../src/lib/prismTerminal";
import { normalizeApiBase } from "../src/hooks/usePrismMarketsAndPortfolio";

/**
 * Regressions for the bugs the live verifier found. Each of these would have
 * broken a UI flow in the browser with an opaque error.
 */

describe("apiBaseUrl normalisation", () => {
  it("does not double the /v1 prefix", () => {
    // The .env ships "https://host/v1" while callers append "/v1/...".
    expect(normalizeApiBase("https://api.prismteleport.xyz/v1")).toBe("https://api.prismteleport.xyz");
    expect(normalizeApiBase("https://api.prismteleport.xyz/v1/")).toBe("https://api.prismteleport.xyz");
    expect(normalizeApiBase("http://localhost:8080")).toBe("http://localhost:8080");
    expect(normalizeApiBase("http://localhost:8080/")).toBe("http://localhost:8080");
  });
});

describe("contract ABI names match the deployed contracts", () => {
  it("uses getNonce for BorrowerOperationsSignatures (nonces() reverts on chain)", () => {
    const names = BORROWER_OPS_SIGNATURES_ABI.map((entry) => entry.name);
    expect(names).toContain("getNonce");
    expect(names).not.toContain("nonces");
  });

  it("uses usedNonces for the router (it flags nonces, it does not count them)", () => {
    const names = ROUTER_ABI.map((entry) => entry.name);
    expect(names).toContain("usedNonces");
    expect(names).not.toContain("nonces");
    const entry = ROUTER_ABI.find((item) => item.name === "usedNonces");
    expect(entry?.inputs).toHaveLength(2);
  });
});

describe("pickFreshRouterNonce", () => {
  it("skips nonces the router has already used", async () => {
    const used = new Set([1000n, 1001n]);
    const client = {
      readContract: vi.fn(async ({ args }: { args: [string, bigint] }) => used.has(args[1])),
    };
    const nonce = await pickFreshRouterNonce(client as never, PRISM_ADDRESSES[31611].router, MEZO_TOKEN, 1000n);
    expect(nonce).toBe(1002n);
  });
});

describe("readPermitDomain", () => {
  it("returns undefined when the token has no EIP-5267 domain (the MEZO precompile)", async () => {
    const client = { readContract: vi.fn(async () => { throw new Error("method not found in ABI"); }) };
    expect(await readPermitDomain(client as never, MEZO_TOKEN)).toBeUndefined();
  });

  it("returns the domain when the token exposes one", async () => {
    const client = {
      readContract: vi.fn(async () => ["0x0f", "MEZO", "1", 31611n, MEZO_TOKEN, "0x" + "00".repeat(32), []]),
    };
    expect(await readPermitDomain(client as never, MEZO_TOKEN)).toEqual({
      name: "MEZO",
      version: "1",
      chainId: 31611,
      verifyingContract: MEZO_TOKEN,
    });
  });
});

describe("paddedGasLimit (EIP-7623 calldata floor)", () => {
  it("lifts an estimate above the floor that rejected the raw estimate", () => {
    // Observed on 31611: estimate 22,044 against a 23,610 floor.
    const padded = paddedGasLimit(22_044n);
    expect(padded).toBeGreaterThan(23_610n);
    expect(padded).toBe(27_555n);
    expect(paddedGasLimit(0n)).toBe(0n);
  });
});
