import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit tests live in test/, outside src/, so `tsc` never compiles them
    // into dist/ (and they stay out of the Docker image).
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Undo vi.spyOn / vi.stubGlobal / fake timers after every test.
    restoreMocks: true,
    unstubGlobals: true,
  },
});
