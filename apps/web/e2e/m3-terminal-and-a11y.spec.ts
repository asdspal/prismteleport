import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/**
 * Milestone 3 E2E + accessibility gate (R-015, R-022, R-023).
 *
 * Every Milestone 3 route is checked at 360x800 (mobile) and 1280x800 (desktop)
 * for zero axe-core violations and zero horizontal overflow, plus the read-only
 * flows a judge can exercise without a wallet.
 */

const ROUTES = [
  { path: "/", heading: /Strip sMUSD yield/i, label: "landing" },
  { path: "/prism", heading: /Borrow once\. Lock the carry\./i, label: "terminal" },
  { path: "/stake", heading: /Stake MEZO\. Cut your Prism fees\./i, label: "staking" },
  { path: "/teleport", heading: /Borrow on Mezo from Base\./i, label: "teleport" },
  { path: "/evidence", heading: /Every claim, traceable\./i, label: "evidence" },
] as const;

const VIEWPORTS = [
  { width: 360, height: 800, label: "360px" },
  { width: 1280, height: 800, label: "1280px" },
] as const;

for (const route of ROUTES) {
  for (const viewport of VIEWPORTS) {
    test(`${route.label} has zero axe violations and no overflow at ${viewport.label}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(route.path);

      await expect(
        page.getByRole("heading", { level: 1, name: route.heading }),
      ).toBeVisible({ timeout: 30_000 });

      // The compliance gate must never block read-only browsing (R-023).
      await expect(page.getByRole("dialog")).toHaveCount(0);

      const results = await new AxeBuilder({ page }).analyze();
      expect(
        results.violations,
        results.violations.map((violation) => violation.id).join(", "),
      ).toEqual([]);

      const overflow = await page.evaluate(() => {
        const root = document.documentElement;
        return root.scrollWidth - root.clientWidth;
      });
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }
}

test("landing calculator renders live on-chain figures without a wallet", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");

  await expect(page.getByRole("heading", { name: /Fixed carry spread calculator/i })).toBeVisible();
  // Live values (trove APR, PT fixed APY) resolve from the API or the on-chain fallback.
  await expect(page.getByText(/Trove borrow APR/)).toBeVisible();
  await expect(page.getByText(/Net guaranteed spread/)).toBeVisible();
  await expect(page.getByRole("link", { name: /Open the Prism terminal/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Live series comparison/i })).toBeVisible();
});

test("header offers the judge demo inspector with no wallet", async ({ page }) => {
  await page.goto("/");

  const judgeToggle = page.getByRole("button", { name: /Inspect Live Demo Trove/i });
  await expect(judgeToggle).toBeVisible();
  await judgeToggle.click();
  await expect(page.getByRole("button", { name: /Inspecting 0xfCe4/i })).toBeVisible();
});

test("/prism exposes the three terminal cards and its position summary", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/prism");

  await expect(page.getByRole("heading", { name: /Your position|Demo position/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: /1-signature borrow & lock/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: /PT \/ YT swap & mint/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Dual-track sMUSD monitor/i })).toBeVisible();

  // Tab navigation inside the PT/YT card.
  await page.getByRole("button", { name: /Buy YT-sMUSD/ }).click();
  await expect(page.getByText(/Flash-mint netting/)).toBeVisible();
  await page.getByRole("button", { name: /Mint \/ Redeem \/ Claim/ }).click();
  await expect(page.getByRole("button", { name: /Claim YT yield/ })).toBeVisible();

  // The testnet-only simulator is clearly labelled (GAP-001).
  await expect(page.getByRole("button", { name: /\[TESTNET SIMULATOR\]/ })).toBeVisible();
});

test("/teleport offers both origins, the micro path and the cross-chain stepper", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/teleport");

  await expect(page.getByRole("button", { name: /Base Sepolia 84532/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Mezo Direct 31611/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Cross-chain receipt/i })).toBeVisible();
  await expect(page.getByText("Step 1")).toBeVisible();

  // A sub-1,800 MUSD borrow auto-selects the shared micro vault (R-011).
  await page.getByLabel(/MUSD to borrow/i).fill("25");
  await expect(page.getByText(/Micro-vault path selected/)).toBeVisible();

  // And a standalone size goes back to the Trove path.
  await page.getByLabel(/MUSD to borrow/i).fill("2000");
  await expect(page.getByText(/Standalone Trove opened in your own address/)).toBeVisible();
});

test("/evidence lists deployments, proofs and opens the embeddable widget", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/evidence");

  await expect(page.getByRole("heading", { name: /Deployed contracts/i })).toBeVisible();
  await expect(page.getByText("TeleportHub", { exact: true })).toBeVisible();
  // Honest reporting of what is not deployed.
  await expect(page.getByText("NOT_DEPLOYED").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: /Test suites/i })).toBeVisible();

  await page.getByRole("button", { name: /Open the widget/i }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("heading", { name: /Teleport a fixed carry/i })).toBeVisible();
});

test("/stake shows the fee tiers and keeps transactions behind the compliance gate", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/stake");

  await expect(page.getByText("10 MEZO → 10% off")).toBeVisible();
  await expect(page.getByText("100 MEZO → 25% off")).toBeVisible();
  await expect(page.getByText("500 MEZO → 50% off")).toBeVisible();

  // No wallet connected: the write buttons stay disabled and no dialog appears.
  await expect(page.getByRole("button", { name: /Stake \(1-signature permit\)/ })).toBeDisabled();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
