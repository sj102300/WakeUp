import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          APP_ACCESS_TOKEN: "test-token",
          DATA_GO_KR_API_KEY: "test-key",
          // 테스트 전용 VAPID 키 (실사용 안 함)
          VAPID_PUBLIC_KEY: "BBVvXXj5R4iM001Qzf0JOr_tmGagW9x1RJXglcszwP5SdNSTf93eCp0f_TsAXEIlopoUtT8NVOLlRj4kZ5FhbI4",
          VAPID_PRIVATE_KEY: "test-private-key-placeholder",
        },
      },
    }),
  ],
});
