import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // Miniflare boots a workerd child process; the first import alone costs
    // over a second, and the D1 quirk suite applies real migration files.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
