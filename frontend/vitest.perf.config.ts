import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Reproducible frontend performance benchmarks. Run with `npm run perf`.
// Separate from `npm test` because the 10k-message scenarios are slow by design.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["perf/**/*.perf.test.{ts,tsx}"],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
