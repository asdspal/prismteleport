import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
config({ path: path.join(repoRoot, ".env") });

function origins(value: string | undefined): string[] {
  return (value ?? "http://localhost:3000")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export const env = {
  port: Number(process.env.PORT ?? 8080),
  testnetRpcUrl:
    process.env.MEZO_TESTNET_RPC_URL ?? "https://rpc.test.mezo.org",
  mainnetRpcUrlPrimary:
    process.env.MEZO_MAINNET_RPC_URL_PRIMARY ??
    "https://mezo-mainnet.boar.network",
  mainnetRpcUrlFallback:
    process.env.MEZO_MAINNET_RPC_URL_FALLBACK ??
    "https://mainnet.mezo.public.validationcloud.io",
  relayerPrivateKey: process.env.RELAYER_PRIVATE_KEY,
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgresql://postgres:postgres@localhost:5432/prism_teleport",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  corsOrigins: origins(process.env.CORS_ALLOWED_ORIGINS),
  mezoTestnetRouter:
    (process.env.MEZO_TESTNET_PRISM_BORROW_LOCK_ROUTER as `0x${string}` | undefined) ??
    "0x7D536A4d33446d556CC8f6758ada141a17e0968b",
  mezoMainnetRouter: process.env.MEZO_MAINNET_PRISM_BORROW_LOCK_ROUTER as
    | `0x${string}`
    | undefined,
  eip7702Whitelist: (process.env.RELAYER_7702_WHITELIST ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  mezoTestnetHintHelpers:
    (process.env.MEZO_TESTNET_HINT_HELPERS as `0x${string}` | undefined) ??
    "0x4e4cBA3779d56386ED43631b4dCD6d8EacEcBCF6",
  mezoTestnetSortedTroves:
    (process.env.MEZO_TESTNET_SORTED_TROVES as `0x${string}` | undefined) ??
    "0x722E4D24FD6Ff8b0AC679450F3D91294607268fA",
  mezoMainnetHintHelpers:
    (process.env.MEZO_MAINNET_HINT_HELPERS as `0x${string}` | undefined) ??
    "0xD267b3bE2514375A075fd03C3D9CBa6b95317DC3",
  mezoMainnetSortedTroves:
    (process.env.MEZO_MAINNET_SORTED_TROVES as `0x${string}` | undefined) ??
    "0x8C5DB4C62BF29c1C4564390d10c20a47E0b2749f",
  /**
   * First block the indexer scans (R-017). Defaults to the PrismTokenizer
   * deployment block recorded in `contracts/deployments/31611.json`.
   */
  indexerStartBlock31611: BigInt(process.env.INDEXER_START_BLOCK_31611 ?? 16381143),
  indexerPollMs: Number(process.env.INDEXER_POLL_MS ?? 30_000),
};
