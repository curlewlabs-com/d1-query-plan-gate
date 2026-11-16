// The tests run inside workerd with a D1 binding, because the plans this
// package compares are only meaningful on D1's own SQLite build.

import { cloudflarePool, cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const poolOptions = {
  miniflare: {
    // The date the Workers runtime pinned by the wrangler devDependency
    // supports; it moves with that pin.
    compatibilityDate: "2026-10-19",
    d1Databases: ["DB"],
  },
};

export default defineConfig({
  plugins: [cloudflareTest(poolOptions)],
  test: {
    pool: cloudflarePool(poolOptions),
    include: ["test/**/*.test.ts"],
  },
});
