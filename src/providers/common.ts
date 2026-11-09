import type { Stop, VehicleObs } from "../trip/engine";
import { type Env, maskSecrets } from "../env";

export type ProviderId = "seoul" | "gyeonggi" | "tago";

export interface RouteInfo {
  /** "<provider>:<공급자 내부 ID>" (TAGO는 "tago:<cityCode>:<routeId>") */
  key: string;
  provider: ProviderId;
  no: string;
  start: string;
  end: string;
  region: string;
  type?: string;
}

export interface Vehicle extends VehicleObs {}

export interface BusProvider {
  id: ProviderId;
  searchRoutes(query: string, region?: string): Promise<RouteInfo[]>;
  getRouteStops(id: string): Promise<Stop[]>;
  getVehicles(id: string): Promise<Vehicle[]>;
}

export class ProviderError extends Error {}

export async function fetchJson(url: string, env: Partial<Env>): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  } catch (e) {
    throw new ProviderError(maskSecrets(`fetch failed: ${url} ${e}`, env));
  }
  const text = await res.text();
  if (!res.ok) throw new ProviderError(maskSecrets(`HTTP ${res.status}: ${url} ${text.slice(0, 200)}`, env));
  try {
    return JSON.parse(text);
  } catch {
    // 키 오류 등은 JSON 요청에도 XML로 응답하는 경우가 있다
    throw new ProviderError(maskSecrets(`non-JSON response: ${url} ${text.slice(0, 200)}`, env));
  }
}

/** 공공 API는 결과가 1건이면 배열 대신 객체를 준다 */
export function list<T>(v: T | T[] | undefined | null | ""): T[] {
  if (v === undefined || v === null || v === "") return [];
  return Array.isArray(v) ? v : [v];
}

export function num(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n !== 0 ? n : undefined;
}

export function str(v: unknown): string {
  return v === undefined || v === null ? "" : String(v);
}

export function requireKey(key: string | undefined, name: string): string {
  if (!key) throw new ProviderError(`${name} secret is not set`);
  return encodeURIComponent(key);
}

export function validateStops(stops: Stop[]): Stop[] {
  if (stops.length < 2) throw new ProviderError("route has fewer than 2 stops");
  for (const s of stops) {
    if (!(s.lat > 32 && s.lat < 39.5 && s.lng > 124 && s.lng < 132)) {
      throw new ProviderError(`stop ${s.id} has invalid coordinates`);
    }
  }
  const sorted = [...stops].sort((a, b) => a.order - b.order);
  sorted.forEach((s, i) => {
    if (i > 0 && s.order === sorted[i - 1].order) throw new ProviderError(`duplicate stop order ${s.order}`);
  });
  return sorted;
}
