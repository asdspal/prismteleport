import { describe, expect, it } from "vitest";
import tokens from "../../../blueprint/design-tokens.json";

function srgbChannel(value: number): number {
  return value <= 0.04045
    ? value / 12.92
    : Math.pow((value + 0.055) / 1.055, 2.4);
}

function luminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  const r = srgbChannel(((value >> 16) & 0xff) / 255);
  const g = srgbChannel(((value >> 8) & 0xff) / 255);
  const b = srgbChannel((value & 0xff) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  const [high, low] = a > b ? [a, b] : [b, a];
  return (high + 0.05) / (low + 0.05);
}

const { color } = tokens;
const bg = {
  primary: color.background.primary.value,
  surface: color.background.surface.value,
  hover: color.background.surfaceHover.value,
  muted: color.background.surfaceMuted.value,
};
const text = {
  primary: color.text.primary.value,
  secondary: color.text.secondary.value,
  inverse: color.text.inverse.value,
};
const brand = {
  amber: color.brand.bitcoinAmber.value,
  cyan: color.brand.prismCyan.value,
  violet: color.brand.mezoViolet.value,
};

const ACTIVE_PAIRS: Array<[string, string, string]> = [
  ["text.primary", text.primary, bg.primary],
  ["text.primary", text.primary, bg.surface],
  ["text.primary", text.primary, bg.hover],
  ["text.primary", text.primary, bg.muted],
  ["text.secondary", text.secondary, bg.primary],
  ["text.secondary", text.secondary, bg.surface],
  ["text.secondary", text.secondary, bg.hover],
  ["text.secondary", text.secondary, bg.muted],
  ["text.inverse / bitcoinAmber", text.inverse, brand.amber],
  ["text.inverse / prismCyan", text.inverse, brand.cyan],
  ["text.inverse / mezoViolet", text.inverse, brand.violet],
  ["bitcoinAmber / bg.primary", brand.amber, bg.primary],
  ["bitcoinAmber / bg.surface", brand.amber, bg.surface],
  ["prismCyan / bg.primary", brand.cyan, bg.primary],
  ["prismCyan / bg.surface", brand.cyan, bg.surface],
  ["mezoViolet / bg.primary", brand.violet, bg.primary],
  ["success / bg.primary", color.semantic.success.value, bg.primary],
  ["success / bg.surface", color.semantic.success.value, bg.surface],
  ["warning / bg.primary", color.semantic.warning.value, bg.primary],
  ["warning / bg.surface", color.semantic.warning.value, bg.surface],
  ["error / bg.primary", color.semantic.error.value, bg.primary],
  ["error / bg.surface", color.semantic.error.value, bg.surface],
  ["info / bg.primary", color.semantic.info.value, bg.primary],
  ["info / bg.surface", color.semantic.info.value, bg.surface],
];

describe("design tokens", () => {
  it("uses the exact IEC 61966-2-1 linearization", () => {
    expect(contrast("#FFFFFF", "#000000")).toBeCloseTo(21, 5);
    expect(contrast("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
  });

  it("passes WCAG 2.1 AA (>= 4.5:1) for every active text/background pair", () => {
    for (const [label, foreground, background] of ACTIVE_PAIRS) {
      const ratio = contrast(foreground, background);
      expect(ratio, `${label} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });

  it("treats disabled text as a documented exemption", () => {
    expect(color.text.Disabled.wcagLevel).toContain("Exempt");
  });
});
