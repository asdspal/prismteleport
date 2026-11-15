import type { FastifyInstance } from "fastify";
import { createWalletClient, http, isAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { env } from "../config";
import { pool } from "../db/pool";
import { createMezoClients, mezoMainnet, mezoTestnet } from "../lib/mezoClient";
import {
  getTeleportIntent,
  INTENT_TYPES,
  relayTeleportIntent,
  TeleportHttpError,
  type IntentTypeName,
  type TeleportIntentBody,
} from "../services/teleportRelayer";

/**
 * `POST /v1/teleport/intent` and `GET /v1/teleport/intent/:intentHash`
 * (R-007, R-008, R-011, R-021): accept a signed cross-chain intent, relay it to
 * `TeleportHub` on Mezo with the bridged BTC, and expose the live status the
 * `/teleport` stepper polls.
 */

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^[0-9]+$/;
const HEX = /^0x[0-9a-fA-F]+$/;

function asUint(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && UINT.test(value)) return value;
  return undefined;
}

function validateBody(raw: unknown): TeleportIntentBody | { error: string } {
  if (typeof raw !== "object" || raw === null) return { error: "JSON body required" };
  const b = raw as Record<string, unknown>;

  const sourceChainId = Number(b.sourceChainId);
  if (!Number.isInteger(sourceChainId)) return { error: "sourceChainId is required" };
  const destChainId = b.destChainId === undefined ? 31611 : Number(b.destChainId);
  if (destChainId !== 31611 && destChainId !== 31612) {
    return { error: "destChainId must be 31611 or 31612" };
  }
  if (typeof b.userAddress !== "string" || !ADDR.test(b.userAddress) || !isAddress(b.userAddress)) {
    return { error: "userAddress must be a 0x address" };
  }
  if (typeof b.intentType !== "string" || !INTENT_TYPES.includes(b.intentType as IntentTypeName)) {
    return { error: `intentType must be one of ${INTENT_TYPES.join(", ")}` };
  }
  const collateralBtcWei = asUint(b.collateralBtcWei);
  if (!collateralBtcWei) return { error: "collateralBtcWei must be an unsigned integer string" };
  const musdAmountWei = asUint(b.musdAmountWei);
  if (!musdAmountWei) return { error: "musdAmountWei must be an unsigned integer string" };
  const minOutputWei = b.minOutputWei === undefined ? "0" : asUint(b.minOutputWei);
  if (minOutputWei === undefined) return { error: "minOutputWei must be an unsigned integer string" };
  const deadline = asUint(b.deadline);
  if (!deadline) return { error: "deadline must be a unix timestamp" };
  if (typeof b.eip712Signature !== "string" || !HEX.test(b.eip712Signature)) {
    return { error: "eip712Signature must be 0x hex" };
  }
  if (b.sourceTxHash !== undefined && (typeof b.sourceTxHash !== "string" || !HEX.test(b.sourceTxHash))) {
    return { error: "sourceTxHash must be 0x hex" };
  }
  if (
    b.mezoBorrowSignature !== undefined &&
    (typeof b.mezoBorrowSignature !== "string" || !HEX.test(b.mezoBorrowSignature))
  ) {
    return { error: "mezoBorrowSignature must be 0x hex" };
  }
  const seriesMaturity = b.seriesMaturity === undefined ? undefined : asUint(b.seriesMaturity);
  if (b.seriesMaturity !== undefined && seriesMaturity === undefined) {
    return { error: "seriesMaturity must be an unsigned integer" };
  }
  const nonce = b.nonce === undefined ? undefined : asUint(b.nonce);

  return {
    sourceChainId,
    destChainId,
    userAddress: b.userAddress as Address,
    intentType: b.intentType as IntentTypeName,
    collateralBtcWei,
    musdAmountWei,
    minOutputWei,
    deadline: Number(deadline),
    eip712Signature: b.eip712Signature as Hex,
    sourceTxHash: b.sourceTxHash as Hex | undefined,
    seriesMaturity: seriesMaturity === undefined ? undefined : Number(seriesMaturity),
    mezoBorrowSignature: b.mezoBorrowSignature as Hex | undefined,
    nonce: nonce === undefined ? undefined : Number(nonce),
  };
}

function errorBody(code: string, message: string, correlationId: string) {
  return { code, message, correlationId };
}

export async function registerTeleportRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/teleport/intent", async (request, reply) => {
    const parsed = validateBody(request.body);
    if ("error" in parsed) {
      return reply.code(400).send(errorBody("BadRequest", parsed.error, request.id));
    }

    const key = env.relayerPrivateKey;
    if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
      return reply
        .code(503)
        .send(errorBody("RelayerUnavailable", "relayer key is not configured", request.id));
    }
    const account = privateKeyToAccount(key as Hex);
    const clients = createMezoClients();
    const chain = parsed.destChainId === 31612 ? mezoMainnet : mezoTestnet;
    const walletClient = createWalletClient({ account, chain, transport: http() });
    const hubAddress =
      parsed.destChainId === 31612 ? env.mezoMainnetTeleportHub : env.mezoTestnetTeleportHub;

    if (!hubAddress) {
      return reply
        .code(400)
        .send(
          errorBody(
            "HubNotDeployed",
            `TeleportHub is not deployed on ${parsed.destChainId}`,
            request.id,
          ),
        );
    }

    try {
      const receipt = await relayTeleportIntent(
        {
          db: pool,
          publicClient: parsed.destChainId === 31612 ? clients.mainnet : clients.testnet,
          walletClient,
          hubAddress: hubAddress as Address,
          relayerAddress: account.address,
          explorerBase: env.mezoTestnetExplorer,
        },
        parsed,
      );
      return reply.code(201).send(receipt);
    } catch (error) {
      if (error instanceof TeleportHttpError) {
        return reply
          .code(error.status)
          .send(errorBody(error.code, error.message, request.id));
      }
      request.log.error?.({ err: error }, "teleport relay failed");
      return reply
        .code(500)
        .send(
          errorBody(
            "RelayError",
            error instanceof Error ? error.message : "teleport relay failed",
            request.id,
          ),
        );
    }
  });

  app.get("/v1/teleport/intent/:intentHash", async (request, reply) => {
    const params = request.params as { intentHash?: string };
    const intentHash = params.intentHash;
    if (!intentHash || !HEX.test(intentHash)) {
      return reply
        .code(400)
        .send(errorBody("BadRequest", "intentHash must be 0x hex", request.id));
    }

    const intent = await getTeleportIntent(pool, intentHash);
    if (!intent) {
      return reply
        .code(404)
        .send(errorBody("NotFound", "unknown intent hash", request.id));
    }
    return reply.code(200).send(intent);
  });
}
