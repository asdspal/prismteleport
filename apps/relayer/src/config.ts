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
  corsOrigins: origins(process.env.CORS_ALLOWED_ORIGINS),
};
