import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The suite launches real browser runtimes (start/stop per test); on a
    // loaded machine a launch can exceed vitest's 5 s default. 30 s keeps
    // the suite deterministic under build/load without masking real hangs.
    testTimeout: 30_000,
  },
});
