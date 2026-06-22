import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@patchproof/adapters-node": fileURLToPath(
        new URL("./packages/adapters-node/src/index.ts", import.meta.url)
      ),
      "@patchproof/adapters-python": fileURLToPath(
        new URL("./packages/adapters-python/src/index.ts", import.meta.url)
      ),
      "@patchproof/codex": fileURLToPath(new URL("./packages/codex/src/index.ts", import.meta.url)),
      "@patchproof/config": fileURLToPath(
        new URL("./packages/config/src/index.ts", import.meta.url)
      ),
      "@patchproof/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@patchproof/github-action": fileURLToPath(
        new URL("./packages/github-action/src/index.ts", import.meta.url)
      ),
      "@patchproof/runner": fileURLToPath(
        new URL("./packages/runner/src/index.ts", import.meta.url)
      )
    }
  },
  test: {
    coverage: {
      exclude: ["**/*.test.ts", "**/dist/**", "fixtures/**"],
      include: ["apps/**/*.ts", "packages/**/*.ts"],
      provider: "v8",
      reporter: ["text", "json-summary"],
      thresholds: {
        "packages/config/src/**": {
          branches: 90,
          functions: 90,
          lines: 90,
          statements: 90
        },
        "packages/core/src/**": {
          branches: 90,
          functions: 90,
          lines: 90,
          statements: 90
        }
      }
    },
    environment: "node",
    globals: true,
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts"],
    testTimeout: 30000
  }
});
