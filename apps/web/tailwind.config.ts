import type { Config } from "tailwindcss";
import tokens from "../../blueprint/design-tokens.json";

const { color, typography, layout } = tokens;

export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: {
          primary: color.background.primary.value,
          surface: color.background.surface.value,
          hover: color.background.surfaceHover.value,
          muted: color.background.surfaceMuted.value,
        },
        text: {
          primary: color.text.primary.value,
          secondary: color.text.secondary.value,
          disabled: color.text.Disabled.value,
          inverse: color.text.inverse.value,
        },
        brand: {
          amber: color.brand.bitcoinAmber.value,
          cyan: color.brand.prismCyan.value,
          violet: color.brand.mezoViolet.value,
        },
        semantic: {
          success: color.semantic.success.value,
          warning: color.semantic.warning.value,
          error: color.semantic.error.value,
          info: color.semantic.info.value,
        },
        border: {
          default: color.border.default.value,
          subtle: color.border.subtle.value,
          focus: color.border.focusRing.value,
        },
      },
      fontFamily: {
        sans: ["var(--font-inter)", typography.fontFamily.sans.value],
        mono: ["var(--font-mono)", typography.fontFamily.mono.value],
      },
      fontSize: {
        xs: [
          typography.scale.xs.fontSize,
          { lineHeight: typography.scale.xs.lineHeight },
        ],
        sm: [
          typography.scale.sm.fontSize,
          { lineHeight: typography.scale.sm.lineHeight },
        ],
        base: [
          typography.scale.base.fontSize,
          { lineHeight: typography.scale.base.lineHeight },
        ],
        lg: [
          typography.scale.lg.fontSize,
          { lineHeight: typography.scale.lg.lineHeight },
        ],
        xl: [
          typography.scale.xl.fontSize,
          { lineHeight: typography.scale.xl.lineHeight },
        ],
        "2xl": [
          typography.scale["2xl"].fontSize,
          { lineHeight: typography.scale["2xl"].lineHeight },
        ],
        "3xl": [
          typography.scale["3xl"].fontSize,
          { lineHeight: typography.scale["3xl"].lineHeight },
        ],
      },
      borderRadius: {
        sm: layout.borderRadius.sm,
        md: layout.borderRadius.md,
        lg: layout.borderRadius.lg,
        full: layout.borderRadius.full,
      },
      screens: {
        xs: layout.breakpoints.xs,
        sm: layout.breakpoints.sm,
        md: layout.breakpoints.md,
        lg: layout.breakpoints.lg,
        xl: layout.breakpoints.xl,
        "2xl": layout.breakpoints["2xl"],
      },
    },
  },
  plugins: [],
} satisfies Config;
