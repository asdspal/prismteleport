import type { FastifyInstance } from "fastify";
import { createWalletClient, http, isAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { env } from "../config";
import { pool } from "../db/pool";
import { createMezoClients, mezoMainnet, mezoTestnet } from "../lib/mezoClient";
import { redisClient } from "../lib/redis";
import {
  relayBorrowAndLock,
  RelayHttpError,
  type RelayBorrowLockBody,
} from "../services/gaslessRelayer";

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^[0-9]+$/;
const HEX = /^0x[0-9a-fA-F]+$/;

function asUint(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  if (typeof value === "string" && UINT.test(value)) return value;
  return undefined;
}

function validateBody(raw: unknown): RelayBorrowLockBody | { error: string } {
  if (typeof raw !== "object" || raw === null) return { error: "JSON body required" };
  const b = raw as Record<string, unknown>;

  if (b.chainId !== 31611 && b.chainId !== 31612) {
    return { error: "chainId must be 31611 or 31612" };
  }
  if (typeof b.borrower !== "string" || !ADDR.test(b.borrower) || !isAddress(b.borrower)) {
    return { error: "borrower must be a 0x address" };
  }
  const musdBorrowAmountWei = asUint(b.musdBorrowAmountWei);
  if (!musdBorrowAmountWei) return { error: "musdBorrowAmountWei must be an unsigned integer string" };
  const seriesMaturity = asUint(b.seriesMaturity);
  if (!seriesMaturity) return { error: "seriesMaturity must be an unsigned integer" };
  const minPtOutWei = asUint(b.minPtOutWei);
  if (!minPtOutWei) return { error: "minPtOutWei must be an unsigned integer string" };
  if (typeof b.upperHint !== "string" || !ADDR.test(b.upperHint)) {
    return { error: "upperHint must be a 0x address" };
  }
  if (typeof b.lowerHint !== "string" || !ADDR.test(b.lowerHint)) {
    return { error: "lowerHint must be a 0x address" };
  }
  const deadline = asUint(b.deadline);
  if (!deadline) return { error: "deadline must be an unsigned integer" };
  const relayerFeeMusd = asUint(b.relayerFeeMusd);
  if (!relayerFeeMusd) return { error: "relayerFeeMusd must be an unsigned integer string" };
  const nonce = asUint(b.nonce);
  if (!nonce) return { error: "nonce must be an unsigned integer" };
  const mezoDeadline = asUint(b.mezoDeadline);
  if (!mezoDeadline) return { error: "mezoDeadline must be an unsigned integer" };
  if (typeof b.eip712Signature !== "string" || !HEX.test(b.eip712Signature)) {
    return { error: "eip712Signature must be 0x-prefixed hex" };
  }
  if (typeof b.mezoBorrowSig !== "string" || !HEX.test(b.mezoBorrowSig)) {
    return { error: "mezoBorrowSig must be 0x-prefixed hex" };
  }

  return {
    chainId: b.chainId,
    borrower: b.borrower,
    musdBorrowAmountWei,
    seriesMaturity: Number(seriesMaturity),
    minPtOutWei,
    upperHint: b.upperHint,
    lowerHint: b.lowerHint,
    deadline: Number(deadline),
    relayerFeeMusd,
    nonce,
    mezoDeadline: Number(mezoDeadline),
    eip712Signature: b.eip712Signature,
    mezoBorrowSig: b.mezoBorrowSig,
  };
}

export async function registerRelayRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/relay/borrow-and-lock", async (request, reply) => {
    const correlationId = request.id;
    const fail = (status: number, code: string, message: string) =>
      reply.code(status).send({ code, message, correlationId });

    const idempotencyKey = request.headers["idempotency-key"];
    if (
      typeof idempotencyKey !== "string" ||
      idempotencyKey.length < 16 ||
      idempotencyKey.length > 128
    ) {
      return fail(400, "BadRequest", "Idempotency-Key header required (16-128 chars)");
    }

    const body = validateBody(request.body);
    if ("error" in body) return fail(400, "BadRequest", body.error);

    const routerAddress =
      body.chainId === 31611 ? env.mezoTestnetRouter : env.mezoMainnetRouter;
    if (!routerAddress) {
      return fail(400, "RouterNotDeployed", `no borrow-lock router configured for ${body.chainId}`);
    }

    const pk = env.relayerPrivateKey;
    if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
      throw new Error("RELAYER_PRIVATE_KEY missing or invalid");
    }
    const account = privateKeyToAccount(pk as `0x${string}`);

    const clients = createMezoClients();
    const isTestnet = body.chainId === 31611;
    const chain = isTestnet ? mezoTestnet : mezoMainnet;
    const publicClient = isTestnet ? clients.testnet : clients.mainnet;
    const walletClient = createWalletClient({
      account,
      chain,
      transport: http(isTestnet ? env.testnetRpcUrl : env.mainnetRpcUrlPrimary, {
        timeout: 15_000,
        retryCount: 2,
      }),
    });
    const explorerBase = `${chain.blockExplorers?.default.url}/tx/`;

    try {
      const result = await relayBorrowAndLock(idempotencyKey, body, {
        db: pool,
        redis: redisClient(),
        publicClient,
        walletClient,
        relayerAddress: account.address as Address,
        routerAddress: routerAddress as Address,
        explorerBase,
        eip7702Whitelist: env.eip7702Whitelist,
      });
      return reply.code(202).send(result);
    } catch (error) {
      if (error instanceof RelayHttpError) {
        return fail(error.statusCode, error.code, error.message);
      }
      request.log.error(error);
      throw error;
    }
  });
}
