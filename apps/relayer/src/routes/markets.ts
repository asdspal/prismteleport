import type { FastifyInstance } from "fastify";
import { fetchMarketsOnChain } from "@prism-teleport/sdk/multicallReaders";
import { pool } from "../db/pool";
import { createMezoClients } from "../lib/mezoClient";

/**
 * `GET /v1/markets` (R-001..R-005, R-016): live PT/YT series, fixed and implied
 * APYs, adapter mode and the net guaranteed carry spread. Values are read
 * straight from chain; `prism_series` is upserted so every series carries a
 * stable UUID and the indexer/history tables share the same identity.
 */

function errorBody(
  code: string,
  message: string,
  correlationId: string,
): { code: string; message: string; correlationId: string } {
  return { code, message, correlationId };
}

function parseChainId(value: unknown): number | undefined {
  if (value === undefined) return 31611;
  const chainId = Number(value);
  return chainId === 31611 || chainId === 31612 ? chainId : undefined;
}

export async function registerMarketsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/markets", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const chainId = parseChainId(query.chainId);
    if (chainId === undefined) {
      return reply
        .code(400)
        .send(errorBody("BadRequest", "chainId must be 31611 or 31612", request.id));
    }

    const clients = createMezoClients();
    const client = chainId === 31612 ? clients.mainnet : clients.testnet;

    let markets;
    try {
      markets = await fetchMarketsOnChain(client, chainId);
    } catch (error) {
      request.log.error?.({ err: error }, "markets read failed");
      return reply
        .code(502)
        .send(
          errorBody(
            "UpstreamRpcError",
            error instanceof Error ? error.message : "upstream RPC read failed",
            request.id,
          ),
        );
    }

    const series: Array<{
      seriesId: string;
      maturityTimestamp: number;
      ptTokenAddress: string;
      ytTokenAddress: string;
      fixedPtApyBps: number;
      impliedYtApyBps: number;
      ptPriceWei: string;
      activeAdapterMode: string;
      netCarrySpreadBps: number;
    }> = [];

    try {
      for (const entry of markets.series) {
        const upserted = await pool.query<{ series_id: string }>(
          `INSERT INTO prism_series
             (chain_id, maturity_timestamp, tokenizer_address, amm_address,
              pt_token_address, yt_token_address, initial_smusd_rate, smoothed_smusd_rate,
              fixed_apy_bps, implied_yt_apy_bps, active_adapter_mode, total_smusd_locked, is_matured)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT (chain_id, maturity_timestamp) DO UPDATE SET
             smoothed_smusd_rate = EXCLUDED.smoothed_smusd_rate,
             fixed_apy_bps = EXCLUDED.fixed_apy_bps,
             implied_yt_apy_bps = EXCLUDED.implied_yt_apy_bps,
             active_adapter_mode = EXCLUDED.active_adapter_mode,
             total_smusd_locked = EXCLUDED.total_smusd_locked,
             is_matured = EXCLUDED.is_matured,
             updated_at = NOW()
           RETURNING series_id`,
          [
            chainId,
            entry.maturityTimestamp,
            markets.tokenizerAddress ?? null,
            markets.ammAddress ?? null,
            entry.ptTokenAddress,
            entry.ytTokenAddress,
            entry.rateAtInit,
            entry.smoothedRate,
            entry.fixedPtApyBps,
            entry.impliedYtApyBps,
            entry.activeAdapterMode,
            entry.totalSmusdLocked,
            entry.isMatured,
          ],
        );

        series.push({
          seriesId: upserted.rows[0].series_id,
          maturityTimestamp: entry.maturityTimestamp,
          ptTokenAddress: entry.ptTokenAddress,
          ytTokenAddress: entry.ytTokenAddress,
          fixedPtApyBps: entry.fixedPtApyBps,
          impliedYtApyBps: entry.impliedYtApyBps,
          ptPriceWei: entry.ptPriceWei,
          activeAdapterMode: entry.activeAdapterMode,
          netCarrySpreadBps: entry.netCarrySpreadBps,
        });
      }
    } catch (error) {
      request.log.error?.({ err: error }, "prism_series upsert failed");
      return reply
        .code(500)
        .send(
          errorBody(
            "IndexerUnavailable",
            error instanceof Error ? error.message : "series cache write failed",
            request.id,
          ),
        );
    }

    return {
      troveFixedBorrowAprBps: markets.troveFixedBorrowAprBps,
      btcPriceUsd: markets.btcPriceUsd,
      series,
    };
  });
}
