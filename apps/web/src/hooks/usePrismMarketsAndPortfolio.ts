"use client";

import { useCallback, useEffect, useState } from "react";
import { createPublicClient, http, type Address, type PublicClient } from "viem";
import {
  fetchMarketsOnChain,
  fetchUserPortfolioOnChain,
} from "@prism-teleport/sdk/multicallReaders";
import { mezoMainnet, mezoTestnet } from "@/lib/chains";

/**
 * API-first market/portfolio data with a direct on-chain fallback (R-015, R-017).
 *
 * The Fastify API is the fast path (indexed + cached). If it is unreachable,
 * times out (> 2,500ms) or answers 5xx, the hook transparently reads the same
 * values straight from Mezo through Multicall3 using the shared SDK readers, and
 * reports `source: "onchain"` so the UI can show the "Direct On-Chain RPC Mode"
 * badge. A reviewer can therefore stop `apps/relayer` entirely and the terminal
 * keeps working.
 */

export const API_TIMEOUT_MS = 2_500;

export function apiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8080";
}

export interface MarketSeriesView {
  seriesId?: string;
  maturityTimestamp: number;
  ptPriceWei?: string;
  ptTokenAddress: string;
  ytTokenAddress: string;
  fixedPtApyBps: number;
  impliedYtApyBps: number;
  activeAdapterMode: string;
  netCarrySpreadBps: number;
}

export interface MarketsView {
  troveFixedBorrowAprBps: number;
  btcPriceUsd: string;
  series: MarketSeriesView[];
}

export interface PortfolioView {
  userAddress: string;
  chainId: number;
  troveCollateralBtc: string;
  troveDebtMusd: string;
  troveIcrBps: number;
  ptBalance: string;
  ytBalance: string;
  stakedMezoBalance: string;
  feeDiscountBps: number;
}

export type DataSource = "api" | "onchain";

export interface PrismData {
  markets?: MarketsView;
  portfolio?: PortfolioView;
  source: DataSource;
  loading: boolean;
  error?: string;
  /** Block the values were read at, for the "Read at block #…" citations. */
  blockNumber?: number;
}

export interface UsePrismDataOptions {
  apiBase?: string;
  timeoutMs?: number;
  /** Injectable for tests; defaults to a browser viem client for the chain. */
  publicClient?: PublicClient;
}

export function createPrismPublicClient(chainId: number): PublicClient {
  return createPublicClient({
    chain: chainId === 31612 ? mezoMainnet : mezoTestnet,
    transport: http(),
  });
}

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`API responded ${response.status}`);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function currentBlock(client: PublicClient): Promise<number | undefined> {
  try {
    return Number(await client.getBlockNumber());
  } catch {
    return undefined;
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "AbortError" ? "API request timed out" : error.message;
  }
  return String(error);
}

export function usePrismMarketsAndPortfolio(
  address: Address | undefined,
  chainId = 31611,
  options: UsePrismDataOptions = {},
): PrismData & { refresh: () => Promise<void> } {
  const { apiBase = apiBaseUrl(), timeoutMs = API_TIMEOUT_MS } = options;
  const [state, setState] = useState<PrismData>({ source: "api", loading: true });

  const load = useCallback(async () => {
    setState((previous) => ({ ...previous, loading: true, error: undefined }));

    try {
      const markets = await fetchJson<MarketsView>(
        `${apiBase}/v1/markets?chainId=${chainId}`,
        timeoutMs,
      );
      const portfolio = address
        ? await fetchJson<PortfolioView>(
            `${apiBase}/v1/positions/${address}?chainId=${chainId}`,
            timeoutMs,
          )
        : undefined;
      setState({
        markets,
        portfolio,
        source: "api",
        loading: false,
        blockNumber: await currentBlock(options.publicClient ?? createPrismPublicClient(chainId)),
      });
      return;
    } catch (apiError) {
      // Fall through to direct RPC reads; surface the API reason only if both fail.
      try {
        const client = options.publicClient ?? createPrismPublicClient(chainId);
        const markets = await fetchMarketsOnChain(client, chainId);
        const portfolio = address
          ? await fetchUserPortfolioOnChain(client, chainId, address)
          : undefined;
        setState({
          markets,
          portfolio,
          source: "onchain",
          loading: false,
          blockNumber: await currentBlock(client),
        });
      } catch (rpcError) {
        setState({
          source: "onchain",
          loading: false,
          error: `${messageOf(apiError)} · on-chain fallback failed: ${messageOf(rpcError)}`,
        });
      }
    }
  }, [address, chainId, apiBase, timeoutMs, options.publicClient]);

  useEffect(() => {
    void load();
  }, [load]);

  return { ...state, refresh: load };
}
