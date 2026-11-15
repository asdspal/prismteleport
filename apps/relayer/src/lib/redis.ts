import Redis from "ioredis";
import { env } from "../config";

let client: Redis | undefined;

/** Shared best-effort Redis client: lazy connect, errors swallowed per command. */
export function redisClient(): Redis {
  if (!client) {
    client = new Redis(env.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 500,
    });
    client.on("error", () => undefined);
    void client.connect().catch(() => undefined);
  }
  return client;
}
