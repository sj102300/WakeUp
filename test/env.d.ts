/// <reference types="@cloudflare/vitest-pool-workers/types" />
import type { Env as AppEnv } from "../src/env";

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {}
  }
}
export {};
