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
