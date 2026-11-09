import type { Env } from "../env";
import type { BusProvider, ProviderId, RouteInfo } from "./common";
import { gyeonggiProvider } from "./gyeonggi";
import { seoulProvider } from "./seoul";
import { tagoProvider } from "./tago";

export * from "./common";

export function providers(env: Partial<Env>) {
  return { seoul: seoulProvider(env), gyeonggi: gyeonggiProvider(env), tago: tagoProvider(env) };
}

/** "<provider>:<id>" 키를 공급자와 공급자 내부 ID로 나눈다 */
export function resolve(env: Partial<Env>, key: string): { provider: BusProvider; id: string } {
  const i = key.indexOf(":");
  const pid = key.slice(0, i) as ProviderId;
  const all = providers(env);
  if (i < 0 || !(pid in all)) throw new Error(`unknown route key ${key}`);
  return { provider: all[pid], id: key.slice(i + 1) };
}

/**
 * region 없음: 서울+경기 동시 검색. region=TAGO 도시코드: 해당 도시만.
 * 한 공급자가 실패해도 나머지 결과는 돌려준다.
 */
export async function searchRoutes(env: Partial<Env>, query: string, region?: string) {
  const all = providers(env);
  const targets: BusProvider[] = region ? [all.tago] : [all.seoul, all.gyeonggi];
  const results = await Promise.allSettled(targets.map((p) => p.searchRoutes(query, region)));
  const routes: RouteInfo[] = [];
  const errors: string[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") routes.push(...r.value);
    else errors.push(`${targets[i].id}: ${r.reason instanceof Error ? r.reason.message : r.reason}`);
  });
  routes.sort((a, b) => a.no.localeCompare(b.no, "ko", { numeric: true }));
  return { routes, errors };
}
