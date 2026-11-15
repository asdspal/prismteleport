import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildTeleportRequest,
  MIN_TROVE_DEBT_MUSD,
  PrismTeleportModal,
  resolveIntentType,
  submitTeleportIntent,
} from "../src/PrismTeleportModal";

/**
 * R-018: the embeddable widget must be droppable into any Base or Mezo dApp.
 * These tests render it server-side (no DOM needed) and pin the intent it
 * builds, including the sub-1,800 MUSD micro auto-detection (R-011).
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveIntentType (micro auto-detection, R-011)", () => {
  it("routes borrows under Mezo's standalone minimum to the micro vault", () => {
    expect(resolveIntentType("BORROW_AND_LOCK_PT", "25")).toBe("MICRO_TELEPORT");
    expect(resolveIntentType("BORROW_AND_LOCK_PT", "1799.99")).toBe("MICRO_TELEPORT");
    expect(resolveIntentType("BORROW_AND_LOCK_PT", MIN_TROVE_DEBT_MUSD)).toBe("BORROW_AND_LOCK_PT");
    expect(resolveIntentType("BORROW_AND_LOCK_PT", "2000")).toBe("BORROW_AND_LOCK_PT");
  });

  it("keeps the requested routing for large borrows and for repayments", () => {
    expect(resolveIntentType("BORROW_AND_TELEPORT_MUSD", "2000")).toBe("BORROW_AND_TELEPORT_MUSD");
    expect(resolveIntentType("REPAY_AND_CLOSE", "25")).toBe("REPAY_AND_CLOSE");
  });
});

describe("buildTeleportRequest", () => {
  it("converts decimals to wei and fills the deadline from the clock", () => {
    const request = buildTeleportRequest({
      sourceChainId: 84532,
      userAddress: "0xfCe44470aC130E66849Aaa23F81D092066ff501E",
      intentType: "BORROW_AND_LOCK_PT",
      collateralBtc: "0.05",
      borrowMusd: "2000",
      eip712Signature: "0x" + "11".repeat(65),
      nowSeconds: 1_700_000_000,
    });

    expect(request.collateralBtcWei).toBe("50000000000000000");
    expect(request.musdAmountWei).toBe("2000000000000000000000");
    expect(request.deadline).toBe(1_700_003_600);
    expect(request.destChainId).toBe(31611);
    expect(request.intentType).toBe("BORROW_AND_LOCK_PT");
  });

  it("switches to MICRO_TELEPORT for a small borrow and clamps bad input", () => {
    const request = buildTeleportRequest({
      sourceChainId: 84532,
      userAddress: "0xfCe44470aC130E66849Aaa23F81D092066ff501E",
      intentType: "BORROW_AND_LOCK_PT",
      collateralBtc: "abc",
      borrowMusd: "25",
      eip712Signature: "0x",
      nowSeconds: 1_700_000_000,
    });

    expect(request.intentType).toBe("MICRO_TELEPORT");
    expect(request.collateralBtcWei).toBe("0");
    expect(request.musdAmountWei).toBe("25000000000000000000");
  });
});

describe("submitTeleportIntent", () => {
  it("posts the intent and returns the receipt", async () => {
    const fetchMock = vi.fn(async () =>
      ({
        ok: true,
        status: 201,
        json: async () => ({
          intentHash: "0x" + "ab".repeat(32),
          status: "EXECUTING_MEZO",
          mezoTxHash: "0x" + "cd".repeat(32),
        }),
      }) as Response,
    );
    vi.stubGlobal("fetch", fetchMock);

    const receipt = await submitTeleportIntent("http://localhost:8080/", {
      sourceChainId: 84532,
      destChainId: 31611,
      userAddress: "0xfCe44470aC130E66849Aaa23F81D092066ff501E",
      intentType: "MICRO_TELEPORT",
      collateralBtcWei: "1000000000000000",
      musdAmountWei: "25000000000000000000",
      minOutputWei: "0",
      deadline: 1_700_003_600,
      eip712Signature: "0x",
    });

    expect(receipt.status).toBe("EXECUTING_MEZO");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    // The trailing slash of the base URL must not double up.
    expect(url).toBe("http://localhost:8080/v1/teleport/intent");
    expect(init.method).toBe("POST");
  });

  it("throws with the relayer's message when the intent is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ({
          ok: false,
          status: 400,
          json: async () => ({ code: "BadRequest", message: "sourceTxHash not found on 84532" }),
        }) as Response,
      ),
    );

    await expect(
      submitTeleportIntent("http://localhost:8080", {} as never),
    ).rejects.toThrow("sourceTxHash not found on 84532");
  });
});

describe("PrismTeleportModal", () => {
  it("renders an accessible dialog with the micro hint for small borrows", () => {
    const html = renderToStaticMarkup(
      <PrismTeleportModal defaultBorrowMusd="25" defaultCollateralBtc="0.001" />,
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('id="prism-teleport-borrow"');
    expect(html).toContain("Teleport a fixed carry");
    expect(html).toContain("shared micro vault");
  });

  it("renders the standalone-Trove hint at or above 1,800 MUSD", () => {
    const html = renderToStaticMarkup(<PrismTeleportModal defaultBorrowMusd="2000" />);
    expect(html).toContain("Standalone Trove in your own address");
  });

  it("accepts host-app children and forwards them into the dialog", () => {
    const html = renderToStaticMarkup(
      <PrismTeleportModal>
        <p>Host app footer</p>
      </PrismTeleportModal>,
    );
    expect(html).toContain("Host app footer");
  });
});
