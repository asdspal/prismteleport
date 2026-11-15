"use client";

import { useCallback } from "react";
import type { Hex } from "viem";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { paddedGasLimit } from "@/lib/prismTerminal";

/**
 * `writeContractAsync` with Mezo's EIP-7623 calldata gas floor covered.
 *
 * viem's gas estimate can land below the floor the node enforces (a warm-storage
 * swap estimated 22,044 against a 23,610 floor), and the transaction is then
 * rejected with an opaque "Missing or invalid parameters" error. Every write in
 * the app goes through this hook so the padding is uniform — the same 25% margin
 * the gasless relayer uses.
 */
export function usePaddedWrite() {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  return useCallback(
    async (params: Record<string, unknown>): Promise<Hex> => {
      if (!publicClient) throw new Error("no RPC client available");
      const estimate = await publicClient.estimateContractGas({
        account: address,
        ...params,
      } as never);
      return writeContractAsync({
        ...params,
        gas: paddedGasLimit(estimate),
      } as never);
    },
    [address, publicClient, writeContractAsync],
  );
}
