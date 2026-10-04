import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        // Local Node server (spawned as a child process)
        test: {
          name: "server",
          include: ["test/node/**/*.test.js"],
          environment: "node",
          // Tests spawn their own server process, so many can run at once
          maxConcurrency: 8,
        },
      },
      {
        // Frontend modules in public/js, run against a simulated DOM
        test: {
          name: "frontend",
          include: ["test/frontend/**/*.test.js"],
          environment: "happy-dom",
        },
      },
      {
        // Cloudflare Worker + Durable Object, run inside workerd via Miniflare
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.toml" },
            miniflare: { bindings: { LEAD_PASSWORD: "test-password" } },
          }),
        ],
        test: {
          name: "worker",
          include: ["test/worker/**/*.test.ts"],
        },
      },
    ],
  },
});
