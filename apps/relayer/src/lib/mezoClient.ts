import {
  createPublicClient,
  fallback,
  http,
  type GetLogsParameters,
  type Log,
  type PublicClient,
  defineChain,
} from "viem";
import { TransactionReceiptNotFoundError } from "viem";
import { env } from "../config";

export const mezoTestnet = defineChain({
  id: 31611,
  name: "Mezo Testnet",
  nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: 18 },
  rpcUrls: {
    default: { http: [env.testnetRpcUrl] },
  },
  blockExplorers: {
    default: { name: "Mezo Testnet Explorer", url: "https://explorer.test.mezo.org" },
  },
});

export const mezoMainnet = defineChain({
  id: 31612,
  name: "Mezo Mainnet",
  nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: 18 },
  rpcUrls: {
    default: { http: [env.mainnetRpcUrlPrimary] },
  },
  blockExplorers: {
    default: { name: "Mezo Explorer", url: "https://explorer.mezo.org" },
  },
});

export function createMezoClients(): {
  testnet: PublicClient;
  mainnet: PublicClient;
} {
  const testnet = createPublicClient({
    chain: mezoTestnet,
    transport: http(env.testnetRpcUrl, { timeout: 15_000, retryCount: 2 }),
  });
  const mainnet = createPublicClient({
    chain: mezoMainnet,
    transport: fallback(
      [
        http(env.mainnetRpcUrlPrimary, { timeout: 15_000, retryCount: 1 }),
        http(env.mainnetRpcUrlFallback, { timeout: 15_000, retryCount: 1 }),
      ],
      { rank: false },
    ),
  });
  return { testnet, mainnet };
}

export type LogsFilter = Omit<GetLogsParameters, "fromBlock" | "toBlock"> & {
  fromBlock: bigint;
  toBlock: bigint;
};

export async function getLogsChunked(
  client: Pick<PublicClient, "getLogs">,
  filter: LogsFilter,
  maxSpan = 9_000n,
): Promise<Log[]> {
  if (maxSpan <= 0n) throw new RangeError("maxSpan must be positive");
  if (filter.fromBlock > filter.toBlock) return [];

  const logs: Log[] = [];
  for (let from = filter.fromBlock; from <= filter.toBlock; from += maxSpan) {
    const last = from + maxSpan - 1n;
    const to = last < filter.toBlock ? last : filter.toBlock;
    const chunk = await client.getLogs({
      ...filter,
      fromBlock: from,
      toBlock: to,
    } as GetLogsParameters);
    logs.push(...chunk);
  }
  return logs;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForReceiptResilient(
  client: Pick<PublicClient, "getTransactionReceipt">,
  txHash: `0x${string}`,
  retries = 5,
  delayMs = 1_500,
): Promise<Awaited<ReturnType<PublicClient["getTransactionReceipt"]>>> {
  if (retries <= 0) throw new RangeError("retries must be positive");

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const receipt = await client.getTransactionReceipt({ hash: txHash });
      if (receipt) return receipt;
    } catch (error) {
      if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
    }
    if (attempt < retries - 1) await sleep(delayMs);
  }
  throw new Error(`receipt not found after ${retries} attempts: ${txHash}`);
}
