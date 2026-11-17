import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // Test-only values; real secrets live in Cloudflare (wrangler secret put).
          bindings: { ADMIN_TOKEN: "test-admin-token", OTP_PEPPER: "test-pepper-0123456789abcdef", DELIVERY_MODE: "console", EMAIL_FROM: "Klausum <otp@mail.klausum.study>", TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: { setupFiles: ["./test/setup.ts"] },
  };
});
