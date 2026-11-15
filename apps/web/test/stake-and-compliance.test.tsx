// @vitest-environment jsdom
import { cleanup, fireEvent, render, renderHook, screen, waitFor, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ComplianceGuardModal,
  useComplianceGuard,
} from "@/components/compliance/ComplianceGuardModal";
import StakePage from "@/app/stake/page";
import {
  formatCooldown,
  MEZO_TOKEN,
  normalizeV,
  PRISM_ADDRESSES,
  PROHIBITED_JURISDICTIONS,
  splitSignature,
  STAKE_TIERS,
} from "@/lib/prismTerminal";
import { parseAmount, WAD } from "@/lib/carry";

/**
 * R-010 / R-023: MEZO staking portal (tiers, flash-stake guard, permit `v`
 * normalisation) and the non-blocking compliance attestation on write actions.
 */

const writeContractAsync = vi.fn();
const signTypedDataAsync = vi.fn();
let readResults: unknown[] = [];

vi.mock("wagmi", () => ({
  useAccount: () => ({
    address: "0xfCe44470aC130E66849Aaa23F81D092066ff501E",
    isConnected: true,
  }),
  useWriteContract: () => ({ writeContractAsync }),
  useSignTypedData: () => ({ signTypedDataAsync }),
  useReadContracts: () => ({
    data: readResults.map((result) => ({ result })),
    refetch: vi.fn(),
  }),
}));

// jsdom in this toolchain does not expose localStorage; install a tiny shim so
// the attestation persistence is still exercised (the app itself already guards
// for browsers where storage is unavailable).
const memoryStorage = new Map<string, string>();
Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => memoryStorage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memoryStorage.set(key, String(value));
    },
    removeItem: (key: string) => {
      memoryStorage.delete(key);
    },
    clear: () => memoryStorage.clear(),
  },
});

beforeEach(() => {
  writeContractAsync
    .mockReset()
    .mockResolvedValue("0xfeed00000000000000000000000000000000000000000000000000000000cafe");
  signTypedDataAsync.mockReset();
  window.localStorage.clear();
  // mezo balance, stakes, pendingMusd, discount, totalStaked, musd balance,
  // permit nonce, eip712 domain
  readResults = [
    parseAmount("75"),
    [parseAmount("50"), BigInt(Math.floor(Date.now() / 1000)), 0n, 0n],
    parseAmount("1.5"),
    1_000n,
    parseAmount("5000"),
    parseAmount("175"),
    3n,
    ["0x0f", "MEZO", "1", 31611n, MEZO_TOKEN, "0x" + "00".repeat(32), []],
  ];
});

afterEach(() => {
  cleanup();
});

describe("staking helpers", () => {
  it("normalises EIP-2612 v values from both wallet conventions", () => {
    expect(normalizeV(0)).toBe(27);
    expect(normalizeV(1)).toBe(28);
    expect(normalizeV(27)).toBe(27);
    expect(normalizeV(28)).toBe(28);
    expect(normalizeV(28n)).toBe(28);
    expect(() => normalizeV(5)).toThrow(RangeError);
  });

  it("splits a 65-byte signature and normalises v", () => {
    const signature = `0x${"11".repeat(32)}${"22".repeat(32)}00` as `0x${string}`;
    const split = splitSignature(signature);
    expect(split.r).toBe(`0x${"11".repeat(32)}`);
    expect(split.s).toBe(`0x${"22".repeat(32)}`);
    expect(split.v).toBe(27);
    expect(() => splitSignature("0x1234" as `0x${string}`)).toThrow(RangeError);
  });

  it("formats the 1-hour anti-flash-stake guard countdown", () => {
    const now = 1_000_000;
    expect(formatCooldown(now, now)).toBe("60m 00s");
    expect(formatCooldown(now, now + 125)).toBe("57m 55s");
    expect(formatCooldown(now, now + 3_600)).toBeUndefined();
    expect(formatCooldown(0, now)).toBeUndefined();
  });

  it("exposes the three fee-discount tiers and the prohibited jurisdictions", () => {
    expect(STAKE_TIERS.map((tier) => tier.discountBps)).toEqual([1_000, 2_500, 5_000]);
    expect(STAKE_TIERS[2].label).toBe("500 MEZO → 50% off");
    expect(PROHIBITED_JURISDICTIONS).toHaveLength(7);
    expect(PROHIBITED_JURISDICTIONS.join(" ")).toMatch(/North Korea/);
    expect(PROHIBITED_JURISDICTIONS.join(" ")).toMatch(/Crimea/);
  });
});

describe("compliance guard (R-023)", () => {
  it("defers a write until the attestation is accepted, then remembers it", async () => {
    const action = vi.fn();
    const { result } = renderHook(() => useComplianceGuard());

    act(() => result.current.guard(action));
    expect(action).not.toHaveBeenCalled();
    expect(result.current.modal.open).toBe(true);

    act(() => result.current.modal.onAttest());
    expect(action).toHaveBeenCalledTimes(1);
    expect(result.current.modal.open).toBe(false);
    expect(window.localStorage.getItem("prism.compliance.attested.v1")).toBe("true");
  });

  it("runs the action immediately once attested and never blocks reads", () => {
    const { result } = renderHook(() => useComplianceGuard());
    act(() => result.current.modal.onAttest());

    const action = vi.fn();
    act(() => result.current.guard(action));
    expect(action).toHaveBeenCalledTimes(1);
    expect(result.current.modal.open).toBe(false);
  });

  it("keeps browsing when the user declines", () => {
    const action = vi.fn();
    const { result } = renderHook(() => useComplianceGuard());
    act(() => result.current.guard(action));
    act(() => result.current.modal.onCancel());

    expect(action).not.toHaveBeenCalled();
    expect(result.current.modal.open).toBe(false);
    expect(result.current.attested).toBe(false);
  });

  it("renders an accessible dialog that requires the attestation checkbox", () => {
    const onAttest = vi.fn();
    render(<ComplianceGuardModal open onAttest={onAttest} onCancel={vi.fn()} />);

    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByText(/North Korea \(KP\)/)).toBeDefined();

    const attestButton = screen.getByText(/Attest & continue/) as HTMLButtonElement;
    expect(attestButton.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(attestButton.disabled).toBe(false);
    fireEvent.click(attestButton);
    expect(onAttest).toHaveBeenCalledTimes(1);
  });
});

describe("StakePage", () => {
  it("renders live balances, the active tier and the flash-stake countdown", () => {
    render(<StakePage />);

    expect(screen.getByText("75.00 MEZO")).toBeDefined();
    expect(screen.getByText("50.00 MEZO")).toBeDefined();
    expect(screen.getByText("10.00%")).toBeDefined(); // 1000 bps discount
    expect(screen.getByText("1.5000 MUSD")).toBeDefined(); // claimable fees
    expect(screen.getByText("Active tier")).toBeDefined();
    expect(screen.getByText(/Discount activates in 60m 00s/)).toBeDefined();
    expect(screen.getByText(/1h anti-flash-loan guard/)).toBeDefined();
    // All three tier cards are present
    expect(screen.getByText("10 MEZO → 10% off")).toBeDefined();
    expect(screen.getByText("100 MEZO → 25% off")).toBeDefined();
    expect(screen.getByText("500 MEZO → 50% off")).toBeDefined();
  });

  it("gates the first transaction behind the compliance attestation", async () => {
    render(<StakePage />);

    fireEvent.click(screen.getByText("Stake (1-signature permit)"));

    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());
    expect(writeContractAsync).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByText(/Attest & continue/));

    await waitFor(() => expect(signTypedDataAsync).toHaveBeenCalled());
  });

  it("claims streamed MUSD fees without a permit once attested", async () => {
    window.localStorage.setItem("prism.compliance.attested.v1", "true");
    render(<StakePage />);

    fireEvent.click(screen.getByText("Claim streamed MUSD fees"));

    await waitFor(() => expect(writeContractAsync).toHaveBeenCalledTimes(1));
    const call = writeContractAsync.mock.calls[0][0] as { address: string; functionName: string };
    expect(call.address).toBe(PRISM_ADDRESSES[31611].feeStaking);
    expect(call.functionName).toBe("claimRewards");
  });

  it("stakes through MEZO with an approval then a stake call", async () => {
    window.localStorage.setItem("prism.compliance.attested.v1", "true");
    render(<StakePage />);

    fireEvent.click(screen.getByText("Approve & stake"));

    await waitFor(() => expect(writeContractAsync).toHaveBeenCalledTimes(2));
    const [approveCall, stakeCall] = writeContractAsync.mock.calls.map(
      (call) => call[0] as { address: string; functionName: string; args: unknown[] },
    );
    expect(approveCall.address).toBe(MEZO_TOKEN);
    expect(approveCall.functionName).toBe("approve");
    expect(approveCall.args[1]).toBe(parseAmount("10"));
    expect(stakeCall.address).toBe(PRISM_ADDRESSES[31611].feeStaking);
    expect(stakeCall.functionName).toBe("stake");
    expect(stakeCall.args[0]).toBe(10n * WAD);
  });
});
