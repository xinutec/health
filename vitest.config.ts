import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // The real-data e2e tests replay a whole captured day through the full
    // classification pipeline (rail/road/walk map-matching + the smoothers),
    // which legitimately takes several seconds per replay. Vitest's 5 s default
    // tips a heavy one over under CI load (a flaky timeout). Give the slow
    // replays real headroom; the unit tests still finish in milliseconds.
    testTimeout: 30_000,
    // Patches BigInt.prototype.toJSON so JSON.stringify works on the
    // bigint values our DB layer now returns. Same side-effect that
    // server.ts / sync.ts import at startup.
    setupFiles: ["./src/bigint-json.ts"],
  },
});
