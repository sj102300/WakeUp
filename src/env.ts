export interface Env {
  DATA_GO_KR_API_KEY?: string;
  SEOUL_BUS_API_KEY?: string;
}

export function maskSecrets(text: string, env: Env): string {
  let out = text.replace(/(serviceKey=)[^&\s"]+/gi, "$1***");
  for (const v of [env.DATA_GO_KR_API_KEY, env.SEOUL_BUS_API_KEY]) {
    if (v) out = out.split(v).join("***").split(encodeURIComponent(v)).join("***");
  }
  return out;
}
