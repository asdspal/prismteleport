"use client";

import { useEffect, useMemo, useState } from "react";
import { useAccount, usePublicClient, useReadContracts, useSignTypedData } from "wagmi";
import { usePaddedWrite } from "@/hooks/usePaddedWrite";
import {
  ComplianceGuardModal,
  useComplianceGuard,
} from "@/components/compliance/ComplianceGuardModal";
import {
  ERC20_ABI,
  ERC20_PERMIT_ABI,
  FEE_STAKING_ABI,
  MEZO_TOKEN,
  PRISM_ADDRESSES,
  STAKE_TIERS,
  formatCooldown,
  readPermitDomain,
  splitSignature,
} from "@/lib/prismTerminal";
import { formatBps, formatMusd, parseAmount } from "@/lib/carry";

/**
 * MEZO staking & fee-rebate portal (R-010): live MEZO balance, the three fee
 * discount tiers, the 1-hour anti-flash-stake guard countdown (STRIDE-03),
 * 1-signature `stakeWithPermit` with `v` normalisation plus standard stake,
 * unstake and streamed MUSD fee claiming. Every write goes through the R-023
 * compliance attestation; reads never do.
 */
export default function StakePage() {
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const writeContractAsync = usePaddedWrite();
  const { signTypedDataAsync } = useSignTypedData();
  const compliance = useComplianceGuard();

  const [amountInput, setAmountInput] = useState("10");
  const [message, setMessage] = useState<string | undefined>();
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000));

  const addresses = PRISM_ADDRESSES[31611];
  const amount = useMemo(() => parseAmount(amountInput), [amountInput]);

  useEffect(() => {
    const timer = setInterval(() => setNowSeconds(Math.floor(Date.now() / 1000)), 1_000);
    return () => clearInterval(timer);
  }, []);

  const { data, refetch } = useReadContracts({
    contracts: [
      { address: MEZO_TOKEN, abi: ERC20_ABI, functionName: "balanceOf", args: [address ?? MEZO_TOKEN] },
      { address: addresses.feeStaking, abi: FEE_STAKING_ABI, functionName: "stakes", args: [address ?? MEZO_TOKEN] },
      { address: addresses.feeStaking, abi: FEE_STAKING_ABI, functionName: "pendingMusd", args: [address ?? MEZO_TOKEN] },
      { address: addresses.feeStaking, abi: FEE_STAKING_ABI, functionName: "getFeeDiscountBps", args: [address ?? MEZO_TOKEN] },
      { address: addresses.feeStaking, abi: FEE_STAKING_ABI, functionName: "totalMezoStaked" },
      { address: addresses.musd, abi: ERC20_ABI, functionName: "balanceOf", args: [address ?? MEZO_TOKEN] },
    ],
    query: { enabled: true },
  });

  const [
    mezoBalance,
    stakeInfo,
    pendingMusd,
    discountBps,
    totalStaked,
    musdBalance,
  ] = (data ?? []).map((entry) => entry?.result) as [
    bigint | undefined,
    readonly [bigint, bigint, bigint, bigint] | undefined,
    bigint | undefined,
    bigint | undefined,
    bigint | undefined,
    bigint | undefined,
  ];

  const staked = stakeInfo?.[0] ?? 0n;
  const lastStake = stakeInfo?.[1] ?? 0n;
  const cooldown = formatCooldown(lastStake, nowSeconds);

  const activeTierIndex = useMemo(() => {
    const discount = Number(discountBps ?? 0n);
    const index = STAKE_TIERS.findIndex((tier) => tier.discountBps === discount);
    return index === -1 ? -1 : index;
  }, [discountBps]);

  async function run(action: () => Promise<string | undefined>) {
    try {
      setMessage("Waiting for wallet confirmation…");
      const hash = await action();
      if (!hash) return; // the action explained itself (e.g. permit unavailable)
      setMessage(`Submitted ${hash.slice(0, 12)}…`);
      await refetch();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Transaction failed");
    }
  }

  const stake = () =>
    compliance.guard(() =>
      void run(async () => {
        await writeContractAsync({
          address: MEZO_TOKEN,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [addresses.feeStaking, amount],
        });
        return writeContractAsync({
          address: addresses.feeStaking,
          abi: FEE_STAKING_ABI,
          functionName: "stake",
          args: [amount],
        });
      }),
    );

  const stakeWithPermit = () =>
    compliance.guard(() =>
      void run(async () => {
        if (!address) throw new Error("connect a wallet first");

        // MEZO on Mezo is a precompile that does not implement EIP-5267, so
        // `eip712Domain()` is unavailable and a permit signature cannot be built
        // correctly. Fall back to the approve + stake path instead of signing a
        // guessed domain (which would revert on chain).
        if (!publicClient) throw new Error("no RPC client available");
        const domain = await readPermitDomain(publicClient, MEZO_TOKEN);
        if (!domain) {
          setMessage(
            "MEZO does not expose EIP-2612 domain data on this chain — use “Approve & stake”.",
          );
          return;
        }

        const nonce = (await publicClient.readContract({
          address: MEZO_TOKEN,
          abi: ERC20_PERMIT_ABI,
          functionName: "nonces",
          args: [address],
        })) as bigint;
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 3_600);
        const signature = (await signTypedDataAsync({
          domain: {
            name: domain.name,
            version: domain.version,
            chainId: domain.chainId,
            verifyingContract: domain.verifyingContract,
          },
          types: {
            Permit: [
              { name: "owner", type: "address" },
              { name: "spender", type: "address" },
              { name: "value", type: "uint256" },
              { name: "nonce", type: "uint256" },
              { name: "deadline", type: "uint256" },
            ],
          },
          primaryType: "Permit",
          message: {
            owner: address,
            spender: addresses.feeStaking,
            value: amount,
            nonce,
            deadline,
          },
        })) as `0x${string}`;

        const { v, r, s } = splitSignature(signature);
        return writeContractAsync({
          address: addresses.feeStaking,
          abi: FEE_STAKING_ABI,
          functionName: "stakeWithPermit",
          args: [amount, deadline, v, r, s],
        });
      }),
    );

  const unstake = () =>
    compliance.guard(() =>
      void run(() =>
        writeContractAsync({
          address: addresses.feeStaking,
          abi: FEE_STAKING_ABI,
          functionName: "unstake",
          args: [amount],
        }),
      ),
    );

  const claimRewards = () =>
    compliance.guard(() =>
      void run(() =>
        writeContractAsync({
          address: addresses.feeStaking,
          abi: FEE_STAKING_ABI,
          functionName: "claimRewards",
          args: [],
        }),
      ),
    );

  return (
    <main id="main" className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-brand-cyan">
            MEZO staking &amp; fee rebate
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-text-primary sm:text-3xl">
            Stake MEZO. Cut your Prism fees.
          </h1>
        </div>
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-tertiary">
          PrismFeeStaking · Mezo 31611
        </span>
      </header>

      <section
        aria-label="Your staking position"
        className="mt-6 rounded-lg border border-border-default bg-bg-surface/60 p-4 sm:p-5"
      >
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div className="flex flex-col gap-0.5">
            <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-tertiary">
              MEZO balance
            </dt>
            <dd className="font-mono text-sm tabular-nums text-text-primary">
              {mezoBalance !== undefined ? `${formatMusd(mezoBalance, 2)} MEZO` : "—"}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-tertiary">
              Staked
            </dt>
            <dd className="font-mono text-sm tabular-nums text-text-primary">
              {staked !== undefined ? `${formatMusd(staked, 2)} MEZO` : "—"}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-tertiary">
              Fee discount
            </dt>
            <dd className="font-mono text-sm tabular-nums text-brand-cyan">
              {discountBps !== undefined ? formatBps(discountBps) : "—"}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-tertiary">
              Claimable fees
            </dt>
            <dd className="font-mono text-sm tabular-nums text-text-primary">
              {pendingMusd !== undefined ? `${formatMusd(pendingMusd, 4)} MUSD` : "—"}
            </dd>
          </div>
        </dl>

        {cooldown ? (
          <p
            role="status"
            className="mt-3 rounded-md border border-brand-amber px-3 py-2 font-mono text-[11px] text-brand-amber"
          >
            Discount activates in {cooldown} (1h anti-flash-loan guard)
          </p>
        ) : (
          <p className="mt-3 text-[11px] text-text-tertiary">
            {staked !== undefined && staked > 0n
              ? "Discount active — no cooldown remaining."
              : `Total staked protocol-wide: ${totalStaked !== undefined ? `${formatMusd(totalStaked, 2)} MEZO` : "—"}`}
          </p>
        )}

        {musdBalance !== undefined ? (
          <p className="mt-2 font-mono text-[11px] text-text-secondary">
            Wallet MUSD: {formatMusd(musdBalance, 2)}
          </p>
        ) : null}
      </section>

      <section
        aria-labelledby="tiers-heading"
        className="mt-5 rounded-lg border border-border-default bg-bg-surface/60 p-4 sm:p-5"
      >
        <h2
          id="tiers-heading"
          className="font-mono text-[11px] uppercase tracking-[0.18em] text-text-secondary"
        >
          Fee discount tiers
        </h2>
        <ul className="mt-3 grid gap-3 sm:grid-cols-3">
          {STAKE_TIERS.map((tier, index) => {
            const active = index === activeTierIndex;
            return (
              <li
                key={tier.label}
                aria-current={active ? "true" : undefined}
                className={`rounded-md border p-3 ${
                  active ? "border-brand-cyan" : "border-border-default"
                }`}
              >
                <p className="font-mono text-sm text-text-primary">{tier.label}</p>
                <p className="mt-1 text-[11px] text-text-tertiary">
                  {formatBps(tier.discountBps)} off swap and mint fees
                </p>
                {active ? (
                  <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-brand-cyan">
                    Active tier
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>

      <section
        aria-labelledby="stake-actions-heading"
        className="mt-5 rounded-lg border border-border-default bg-bg-surface/60 p-4 sm:p-5"
      >
        <h2
          id="stake-actions-heading"
          className="font-mono text-[11px] uppercase tracking-[0.18em] text-text-secondary"
        >
          Stake, unstake and claim
        </h2>

        <label className="mt-4 flex flex-col gap-1 sm:max-w-xs">
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-text-tertiary">
            MEZO amount
          </span>
          <input
            inputMode="decimal"
            value={amountInput}
            onChange={(event) => setAmountInput(event.target.value)}
            className="rounded-md border border-border-default bg-bg-primary px-3 py-2 font-mono text-sm text-text-primary focus:border-brand-cyan focus:outline-none"
          />
        </label>

        {message ? (
          <p role="status" className="mt-3 text-xs text-text-secondary">
            {message}
          </p>
        ) : null}

        {!isConnected ? (
          <p className="mt-3 text-xs text-text-tertiary">
            Connect a wallet to stake, unstake or claim. Browsing stays open without
            one.
          </p>
        ) : null}

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={!isConnected || amount <= 0n}
            onClick={stakeWithPermit}
            className="rounded-md border border-brand-cyan px-4 py-2 font-mono text-[11px] uppercase tracking-[0.14em] text-brand-cyan transition-colors hover:bg-brand-cyan/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Stake (1-signature permit)
          </button>
          <button
            type="button"
            disabled={!isConnected || amount <= 0n}
            onClick={stake}
            className="rounded-md border border-border-default px-4 py-2 font-mono text-[11px] uppercase tracking-[0.14em] text-text-secondary transition-colors hover:text-text-primary disabled:opacity-40"
          >
            Approve &amp; stake
          </button>
          <button
            type="button"
            disabled={!isConnected || amount <= 0n}
            onClick={unstake}
            className="rounded-md border border-border-default px-4 py-2 font-mono text-[11px] uppercase tracking-[0.14em] text-text-secondary transition-colors hover:text-text-primary disabled:opacity-40"
          >
            Unstake
          </button>
          <button
            type="button"
            disabled={!isConnected}
            onClick={claimRewards}
            className="rounded-md border border-border-default px-4 py-2 font-mono text-[11px] uppercase tracking-[0.14em] text-text-secondary transition-colors hover:text-text-primary disabled:opacity-40"
          >
            Claim streamed MUSD fees
          </button>
        </div>

        <p className="mt-4 text-[11px] text-text-tertiary">
          {compliance.attested
            ? "Terms attested on this device — transactions send immediately."
            : "A one-time terms and jurisdiction attestation is requested before the first transaction."}
        </p>
      </section>

      <ComplianceGuardModal {...compliance.modal} />
    </main>
  );
}
