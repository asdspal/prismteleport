import type { Address, PublicClient } from "viem";

export interface HintContracts {
  hintHelpers: Address;
  sortedTroves: Address;
}

/** Canonical Mezo HintHelpers / SortedTroves per chain. */
export const MEZO_HINT_CONTRACTS: Record<number, HintContracts> = {
  31611: {
    hintHelpers: "0x4e4cBA3779d56386ED43631b4dCD6d8EacEcBCF6",
    sortedTroves: "0x722E4D24FD6Ff8b0AC679450F3D91294607268fA",
  },
  31612: {
    hintHelpers: "0xD267b3bE2514375A075fd03C3D9CBa6b95317DC3",
    sortedTroves: "0x8C5DB4C62BF29c1C4564390d10c20a47E0b2749f",
  },
};

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

const SORTED_TROVES_ABI = [
  {
    type: "function",
    name: "getSize",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "findInsertPosition",
    stateMutability: "view",
    inputs: [
      { name: "nicr", type: "uint256" },
      { name: "prevId", type: "address" },
      { name: "nextId", type: "address" },
    ],
    outputs: [
      { type: "address" },
      { type: "address" },
    ],
  },
] as const;

const HINT_HELPERS_ABI = [
  {
    type: "function",
    name: "getApproxHint",
    stateMutability: "view",
    inputs: [
      { name: "nicr", type: "uint256" },
      { name: "numTrials", type: "uint256" },
      { name: "inputRandomSeed", type: "uint256" },
    ],
    outputs: [
      { name: "hintAddress", type: "address" },
      { name: "diff", type: "uint256" },
      { name: "latestRandomSeed", type: "uint256" },
    ],
  },
] as const;

/**
 * Nominal ICR used by Mezo SortedTroves ordering.
 * Matches on-chain `HintHelpers.computeNominalCR(coll, debt)`.
 */
export function computeNicr(collateralBtcWei: bigint, debtMusdWei: bigint): bigint {
  if (debtMusdWei <= 0n) throw new RangeError("debtMusdWei must be > 0");
  if (collateralBtcWei < 0n) throw new RangeError("collateralBtcWei must be >= 0");
  return (collateralBtcWei * 10n ** 20n) / debtMusdWei;
}

/** Liquity/Mezo official trials formula, clamped to [15, 250]. */
export function approxHintTrials(totalTroves: number | bigint): number {
  const size = Number(totalTroves);
  return Math.min(250, Math.max(15, Math.ceil(15 * Math.sqrt(size))));
}

export interface TroveHints {
  nicr: bigint;
  upperHint: Address;
  lowerHint: Address;
}

/**
 * Compute exact SortedTroves insertion hints. Runs in Node or the browser:
 * only needs a viem PublicClient (direct RPC or Multicall3-capable transport).
 */
export async function computeTroveHints(
  client: Pick<PublicClient, "readContract">,
  chainId: number,
  collateralBtcWei: bigint,
  debtMusdWei: bigint,
  contracts: HintContracts = MEZO_HINT_CONTRACTS[chainId],
): Promise<TroveHints> {
  if (!contracts) throw new RangeError(`unsupported chainId: ${chainId}`);
  const nicr = computeNicr(collateralBtcWei, debtMusdWei);

  const size = await client.readContract({
    address: contracts.sortedTroves,
    abi: SORTED_TROVES_ABI,
    functionName: "getSize",
  });

  if (size <= 2n) {
    return { nicr, upperHint: ZERO_ADDRESS, lowerHint: ZERO_ADDRESS };
  }

  const trials = BigInt(approxHintTrials(size));
  const [approx] = await client.readContract({
    address: contracts.hintHelpers,
    abi: HINT_HELPERS_ABI,
    functionName: "getApproxHint",
    args: [nicr, trials, 42n],
  });

  const [upperHint, lowerHint] = await client.readContract({
    address: contracts.sortedTroves,
    abi: SORTED_TROVES_ABI,
    functionName: "findInsertPosition",
    args: [nicr, approx, approx],
  });

  return { nicr, upperHint, lowerHint };
}
