import type { AppObject } from "./objects/app";

export interface Env {
  APP: DurableObjectNamespace<AppObject>;
  ASSETS: Fetcher;
  DATA_GO_KR_API_KEY?: string;
  SEOUL_BUS_API_KEY?: string;
  APP_ACCESS_TOKEN?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}

export const REQUIRED_SECRETS = [
  "DATA_GO_KR_API_KEY",
  "APP_ACCESS_TOKEN",
  "VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_KEY",
] as const;

export function maskSecrets(text: string, env: Partial<Env>): string {
  let out = text.replace(/(serviceKey=)[^&\s"]+/gi, "$1***");
  for (const v of [env.DATA_GO_KR_API_KEY, env.SEOUL_BUS_API_KEY, env.APP_ACCESS_TOKEN, env.VAPID_PRIVATE_KEY]) {
    if (v) out = out.split(v).join("***").split(encodeURIComponent(v)).join("***");
  }
  return out;
}
