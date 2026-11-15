import Redis from "ioredis";
import type { FastifyInstance } from "fastify";
import type { Address } from "viem";
import { computeTroveHints, type HintContracts } from "@prism-teleport/sdk";
import { env } from "../config";
import { createMezoClients } from "../lib/mezoClient";

/** OpenAPI HintsResponse.estimatedGas example; measured with live hints. */
const ESTIMATED_GAS = 590_000;
const CACHE_TTL_SECONDS = 5;

const PARAM_PATTERN = /^[0-9]+$/;
const CHAIN_IDS = new Set([31611, 31612]);

type RedisClient = Pick<Redis, "get" | "set" | "quit">;

let redis: Redis | undefined;

function cacheClient(): RedisClient | undefined {
  if (redis) return redis;
  try {
    redis = new Redis(env.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 500,
    });
    redis.on("error", () => {
      /* cache is best-effort; errors swallowed per-command */
    });
    void redis.connect().catch(() => undefined);
    return redis;
  } catch {
    return undefined;
  }
}

export function contractsFor(chainId: number): HintContracts {
  if (chainId === 31611) {
    return {
      hintHelpers: env.mezoTestnetHintHelpers as Address,
      sortedTroves: env.mezoTestnetSortedTroves as Address,
    };
  }
  return {
    hintHelpers: env.mezoMainnetHintHelpers as Address,
    sortedTroves: env.mezoMainnetSortedTroves as Address,
  };
}

interface ParsedQuery {
  chainId: number;
  collateralBtcWei: bigint;
  debtMusdWei: bigint;
}

function parseQuery(query: Record<string, unknown>): ParsedQuery | { error: string } {
  const { chainId, collateralBtcWei, debtMusdWei } = query;

  if (chainId === undefined || collateralBtcWei === undefined || debtMusdWei === undefined) {
    return { error: "chainId, collateralBtcWei and debtMusdWei are required" };
  }

  const chainNum = Number(chainId);
  if (!Number.isInteger(chainNum) || !CHAIN_IDS.has(chainNum)) {
    return { error: "chainId must be 31611 or 31612" };
  }

  const coll = String(collateralBtcWei);
  const debt = String(debtMusdWei);
  if (!PARAM_PATTERN.test(coll)) {
    return { error: "collateralBtcWei must be a non-negative integer string" };
  }
  if (!PARAM_PATTERN.test(debt)) {
    return { error: "debtMusdWei must be a non-negative integer string" };
  }
  if (BigInt(debt) === 0n) {
    return { error: "debtMusdWei must be > 0" };
  }

  return { chainId: chainNum, collateralBtcWei: BigInt(coll), debtMusdWei: BigInt(debt) };
}

export async function registerHintsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/hints", async (request, reply) => {
    const parsed = parseQuery(request.query as Record<string, unknown>);
    if ("error" in parsed) {
      return reply.code(400).send({ error: parsed.error });
    }

    const { chainId, collateralBtcWei, debtMusdWei } = parsed;
    const cacheKey = `hints:${chainId}:${collateralBtcWei}:${debtMusdWei}`;

    const client = cacheClient();
    if (client) {
      try {
        const hit = await client.get(cacheKey);
        if (hit) return reply.code(200).send(JSON.parse(hit));
      } catch {
        /* best-effort cache */
      }
    }

    const clients = createMezoClients();
    const publicClient = chainId === 31611 ? clients.testnet : clients.mainnet;
    const startedAt = process.hrtime.bigint();

    const { nicr, upperHint, lowerHint } = await computeTroveHints(
      publicClient,
      chainId,
      collateralBtcWei,
      debtMusdWei,
      contractsFor(chainId),
    );

    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const body = {
      nicr: nicr.toString(),
      upperHint,
      lowerHint,
      estimatedGas: ESTIMATED_GAS,
    };

    if (client) {
      try {
        await client.set(cacheKey, JSON.stringify(body), "EX", CACHE_TTL_SECONDS);
      } catch {
        /* best-effort cache */
      }
    }

    request.log.info(
      { chainId, elapsedMs, nicr: body.nicr },
      "hints computed",
    );
    return reply.code(200).send(body);
  });
}

export const hintsTestOnly = { parseQuery, ESTIMATED_GAS };
