import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "src");

export default defineConfig({
  // Next.js compiles JSX with the automatic runtime (React 19, no React import).
  esbuild: { jsx: "automatic" },
  resolve: {
    // Mirrors the `@/*` path alias from tsconfig.json.
    alias: { "@": srcDir },
  },
  test: {
    // Node for pure logic tests; the .tsx suites opt into jsdom via
    // `// @vitest-environment jsdom` at the top of the file.
    environment: "node",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
  },
});
