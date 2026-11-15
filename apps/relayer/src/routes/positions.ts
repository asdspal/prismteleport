import type { FastifyInstance } from "fastify";
import { isAddress, type Address } from "viem";
import { fetchUserPortfolioOnChain } from "@prism-teleport/sdk/multicallReaders";
import { pool } from "../db/pool";
import { createMezoClients } from "../lib/mezoClient";

/**
 * `GET /v1/positions/:address` (R-010, R-015): the user's live Trove health,
 * PT/YT balances, MEZO staking tier and fee discount, read in Multicall3 batches
 * and cached into `user_positions` so the indexer and this route agree.
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

export async function registerPositionsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/positions/:address", async (request, reply) => {
    const params = request.params as { address?: string };
    const query = request.query as Record<string, unknown>;

    const address = params.address;
    if (!address || !isAddress(address)) {
      return reply
        .code(400)
        .send(errorBody("BadRequest", "address must be a 0x address", request.id));
    }

    const chainId = parseChainId(query.chainId);
    if (chainId === undefined) {
      return reply
        .code(400)
        .send(errorBody("BadRequest", "chainId must be 31611 or 31612", request.id));
    }

    const clients = createMezoClients();
    const client = chainId === 31612 ? clients.mainnet : clients.testnet;

    let portfolio;
    try {
      portfolio = await fetchUserPortfolioOnChain(client, chainId, address as Address);
    } catch (error) {
      request.log.error?.({ err: error }, "portfolio read failed");
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

    try {
      await pool.query(
        `INSERT INTO user_positions
           (user_address, chain_id, trove_collateral_btc, trove_debt_musd, trove_icr_bps,
            pt_balance, yt_balance, claimable_yield_musd, claimable_yield_mezo,
            staked_mezo_balance, fee_discount_bps, last_synced_block, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
         ON CONFLICT (user_address, chain_id) DO UPDATE SET
           trove_collateral_btc = EXCLUDED.trove_collateral_btc,
           trove_debt_musd = EXCLUDED.trove_debt_musd,
           trove_icr_bps = EXCLUDED.trove_icr_bps,
           pt_balance = EXCLUDED.pt_balance,
           yt_balance = EXCLUDED.yt_balance,
           claimable_yield_musd = EXCLUDED.claimable_yield_musd,
           claimable_yield_mezo = EXCLUDED.claimable_yield_mezo,
           staked_mezo_balance = EXCLUDED.staked_mezo_balance,
           fee_discount_bps = EXCLUDED.fee_discount_bps,
           last_synced_block = EXCLUDED.last_synced_block,
           updated_at = NOW()`,
        [
          portfolio.userAddress,
          portfolio.chainId,
          portfolio.troveCollateralBtc,
          portfolio.troveDebtMusd,
          portfolio.troveIcrBps,
          portfolio.ptBalance,
          portfolio.ytBalance,
          portfolio.claimableYieldMusd,
          portfolio.claimableYieldMezo,
          portfolio.stakedMezoBalance,
          portfolio.feeDiscountBps,
          portfolio.lastSyncedBlock,
        ],
      );
    } catch (error) {
      request.log.error?.({ err: error }, "user_positions upsert failed");
      return reply
        .code(500)
        .send(
          errorBody(
            "IndexerUnavailable",
            error instanceof Error ? error.message : "position cache write failed",
            request.id,
          ),
        );
    }

    return {
      userAddress: portfolio.userAddress,
      chainId: portfolio.chainId,
      troveCollateralBtc: portfolio.troveCollateralBtc,
      troveDebtMusd: portfolio.troveDebtMusd,
      troveIcrBps: portfolio.troveIcrBps,
      ptBalance: portfolio.ptBalance,
      ytBalance: portfolio.ytBalance,
      stakedMezoBalance: portfolio.stakedMezoBalance,
      feeDiscountBps: portfolio.feeDiscountBps,
    };
  });
}
