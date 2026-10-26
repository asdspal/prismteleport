"use client";

import { useEffect, useState } from "react";
import { createPublicClient, http } from "viem";
import { mezoMainnet, mezoTestnet } from "@/lib/chains";

type Status = {
  testnet?: number;
  mainnet?: number;
  failed: boolean;
};

export function NetworkStatus() {
  const [status, setStatus] = useState<Status>({ failed: false });

  useEffect(() => {
    let cancelled = false;
    const testnet = createPublicClient({
      chain: mezoTestnet,
      transport: http(undefined, { timeout: 8_000 }),
    });
    const mainnet = createPublicClient({
      chain: mezoMainnet,
      transport: http(undefined, { timeout: 8_000 }),
    });

    Promise.allSettled([
      testnet.getBlockNumber(),
      mainnet.getBlockNumber(),
    ]).then(([testnetBlock, mainnetBlock]) => {
      if (cancelled) return;
      setStatus({
        testnet:
          testnetBlock.status === "fulfilled"
            ? Number(testnetBlock.value)
            : undefined,
        mainnet:
          mainnetBlock.status === "fulfilled"
            ? Number(mainnetBlock.value)
            : undefined,
        failed:
          testnetBlock.status === "rejected" ||
          mainnetBlock.status === "rejected",
      });
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const loading =
    status.testnet === undefined && status.mainnet === undefined && !status.failed;
  const offline =
    status.failed && status.testnet === undefined && status.mainnet === undefined;

  const text = loading
    ? "Connecting…"
    : offline
      ? "RPC offline"
      : `Testnet ${status.testnet?.toLocaleString("en-US") ?? "—"} · Mainnet ${
          status.mainnet?.toLocaleString("en-US") ?? "—"
        }`;

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-w-0 max-w-full items-center gap-2 rounded-full border border-border-default bg-bg-muted px-3 py-1 font-mono text-xs text-text-secondary"
    >
      <span
        aria-hidden="true"
        className={`h-2 w-2 shrink-0 rounded-full ${
          offline
            ? "bg-semantic-warning"
            : loading
              ? "bg-text-secondary"
              : "bg-semantic-success"
        }`}
      />
      <span className="min-w-0 break-words">{text}</span>
    </div>
  );
}
