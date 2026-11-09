import { distanceM } from "./geo";
import type { Stop } from "./engine";

export interface SavedStop {
  id: string;
  name: string;
  lat: number;
  lng: number;
}

export type StopMatch =
  | { kind: "same"; stop: Stop }
  | { kind: "moved"; stop: Stop; distanceM: number }
  | { kind: "missing" };

const NEAR_M = 200;

/**
 * 노선 개편 후 저장된 정류장을 최신 목록에서 찾는다.
 * ID가 그대로면 same, 이름이 같거나 200m 이내면 moved(확인 필요), 없으면 missing.
 */
export function matchStop(stops: Stop[], saved: SavedStop): StopMatch {
  const same = stops.find((s) => s.id === saved.id);
  if (same) return { kind: "same", stop: same };
  let best: { stop: Stop; d: number } | undefined;
  for (const s of stops) {
    const d = distanceM(s, saved);
    const ok = s.name === saved.name || d <= NEAR_M;
    if (ok && (!best || d < best.d)) best = { stop: s, d };
  }
  return best ? { kind: "moved", stop: best.stop, distanceM: Math.round(best.d) } : { kind: "missing" };
}

export function toSaved(s: Stop): SavedStop {
  return { id: s.id, name: s.name, lat: s.lat, lng: s.lng };
}
