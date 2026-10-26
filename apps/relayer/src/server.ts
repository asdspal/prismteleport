import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { formatEther, isAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { env } from "./config";
import { createMezoClients } from "./lib/mezoClient";

function relayerAddress(): Address | undefined {
  const explicit = process.env.RELAYER_ADDRESS;
  if (explicit && isAddress(explicit)) return explicit;

  const key = env.relayerPrivateKey;
  if (key && /^0x[0-9a-fA-F]{64}$/.test(key)) {
    return privateKeyToAccount(key as `0x${string}`).address;
  }
  return undefined;
}

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    trustProxy: true,
    genReqId: (request) =>
      (request.headers["x-correlation-id"] as string | undefined) ??
      randomUUID(),
  });

  await app.register(cors, { origin: env.corsOrigins });
  await app.register(rateLimit, { max: 100, timeWindow: "1 minute" });

  app.addHook("onSend", async (request, reply) => {
    reply.header("x-correlation-id", request.id);
  });

  app.get("/v1/health", async () => {
    const clients = createMezoClients();
    let status: "ok" | "degraded" = "ok";
    let mezoTestnetBlock = 0;
    let mezoMainnetBlock = 0;
    let relayerGasBtc = "0";

    try {
      mezoTestnetBlock = Number(await clients.testnet.getBlockNumber());
    } catch {
      status = "degraded";
    }

    try {
      mezoMainnetBlock = Number(await clients.mainnet.getBlockNumber());
    } catch {
      status = "degraded";
    }

    const address = relayerAddress();
    if (address) {
      try {
        const balance = await clients.testnet.getBalance({ address });
        relayerGasBtc = formatEther(balance);
      } catch {
        status = "degraded";
      }
    }

    return { status, mezoTestnetBlock, mezoMainnetBlock, relayerGasBtc };
  });

  return app;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const app = await buildServer();
  await app.listen({ port: env.port, host: "0.0.0.0" });
}
