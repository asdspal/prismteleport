import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

for (const viewport of [
  { width: 360, height: 800, label: "360px" },
  { width: 1280, height: 800, label: "1280px" },
]) {
  test(`shell has zero axe violations and no horizontal overflow at ${viewport.label}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/");

    await expect(
      page.getByRole("heading", { level: 1, name: /Strip sMUSD yield/i }),
    ).toBeVisible();

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
