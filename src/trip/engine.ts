import { distanceM, projectRatio, type LatLng } from "./geo";

export interface Stop extends LatLng {
  id: string;
  /** 노선 내 순번 (1부터) */
  order: number;
  name: string;
}

export interface VehicleObs {
  vehicleNo: string;
  /** 차량이 마지막으로 통과한 정류장 순번 */
  stopOrder: number;
  lat?: number;
  lng?: number;
}

export interface TripConfig {
  stops: Stop[];
  boardOrder: number;
  destOrder: number;
  /** 몇 정거장 전에 알릴지 */
  alertBefore: number;
  startedAt: number;
}

export type DoneReason = "arrived" | "lost" | "timeout" | "cancelled";

export interface TripState {
  phase: "tracking" | "alerted" | "done";
  /** 관측 기반 노선 위 진행 거리(m) */
  progressM: number;
  /** 진행 거리가 마지막으로 바뀐 시각 */
  progressAt: number;
  /** 최근 속도 추정(m/s) */
  speedMps: number;
  lastStopOrder: number;
  missing: number;
  doneReason?: DoneReason;
}

export type TripEvent =
  | { type: "alert"; stopsLeft: number; estimated: boolean }
  | { type: "done"; reason: DoneReason };

export const TUNING = {
  alertMarginM: 50,
  alertRadiusM: 150,
  /** 관측이 이 시간 이상 안 바뀌면 속도로 위치 추정 */
  staleMs: 45_000,
  defaultSpeedMps: 5,
  maxSpeedMps: 15,
  maxMissing: 3,
  maxTripMs: 3 * 60 * 60 * 1000,
  farPollMs: 60_000,
  nearPollMs: 20_000,
  farStops: 5,
};

export class Route {
  readonly cum: number[];
  private byOrder = new Map<number, number>();

  constructor(readonly stops: Stop[]) {
    this.cum = [0];
    stops.forEach((s, i) => {
      this.byOrder.set(s.order, i);
      if (i > 0) this.cum.push(this.cum[i - 1] + distanceM(stops[i - 1], s));
    });
  }

  index(order: number): number {
    const i = this.byOrder.get(order);
    if (i === undefined) throw new Error(`unknown stop order ${order}`);
    return i;
  }

  at(order: number): number {
    return this.cum[this.index(order)];
  }

  /** 관측 하나를 노선 위 진행 거리로 변환 */
  progressOf(obs: VehicleObs): number {
    const i = this.byOrder.get(obs.stopOrder);
    if (i === undefined) return obs.stopOrder < this.stops[0].order ? 0 : this.cum[this.cum.length - 1];
    if (obs.lat === undefined || obs.lng === undefined || i + 1 >= this.stops.length) return this.cum[i];
    const r = projectRatio({ lat: obs.lat, lng: obs.lng }, this.stops[i], this.stops[i + 1]);
    return this.cum[i] + r * (this.cum[i + 1] - this.cum[i]);
  }
}

export function initialState(cfg: TripConfig, route: Route): TripState {
  return {
    phase: "tracking",
    progressM: route.at(cfg.boardOrder),
    progressAt: cfg.startedAt,
    speedMps: TUNING.defaultSpeedMps,
    lastStopOrder: cfg.boardOrder,
    missing: 0,
  };
}

/**
 * 조회 결과 하나를 반영한다. obs가 null이면 차량이 목록에 없었던 것.
 * 순수 함수: 상태와 이벤트, 다음 조회까지의 대기 시간을 돌려준다.
 */
export function step(
  cfg: TripConfig,
  route: Route,
  prev: TripState,
  obs: VehicleObs | null,
  now: number,
): { state: TripState; events: TripEvent[]; nextPollMs: number | null } {
  if (prev.phase === "done") return { state: prev, events: [], nextPollMs: null };
  const s: TripState = { ...prev };
  const events: TripEvent[] = [];
  const finish = (reason: DoneReason) => {
    s.phase = "done";
    s.doneReason = reason;
    events.push({ type: "done", reason });
    return { state: s, events, nextPollMs: null };
  };

  if (now - cfg.startedAt > TUNING.maxTripMs) return finish("timeout");

  if (!obs) {
    s.missing += 1;
    if (s.missing >= TUNING.maxMissing) return finish("lost");
  } else {
    s.missing = 0;
    s.lastStopOrder = Math.max(s.lastStopOrder, obs.stopOrder);
    const p = route.progressOf(obs);
    // 역행은 GPS 오차로 보고 무시
    if (p > s.progressM + 1) {
      const dt = (now - s.progressAt) / 1000;
      if (dt > 0) {
        const v = Math.min(TUNING.maxSpeedMps, (p - s.progressM) / dt);
        s.speedMps = 0.5 * s.speedMps + 0.5 * v;
      }
      s.progressM = p;
      s.progressAt = now;
    }
    if (s.lastStopOrder >= cfg.destOrder || s.progressM >= route.at(cfg.destOrder) - 30) {
      return finish("arrived");
    }
  }

  const alertOrder = Math.max(cfg.boardOrder, cfg.destOrder - cfg.alertBefore);
  const alertAt = route.at(alertOrder);

  if (s.phase === "tracking") {
    const stale = now - s.progressAt >= TUNING.staleMs;
    // 추정은 다음 정류장까지만 허용 (멈춘 버스를 과하게 앞서가지 않도록)
    const nextIdx = Math.min(route.index(s.lastStopOrder) + 1, route.cum.length - 1);
    const estimated = stale
      ? Math.min(route.cum[nextIdx], s.progressM + (s.speedMps * (now - s.progressAt)) / 1000)
      : s.progressM;
    const alertStop = route.stops[route.index(alertOrder)];
    const nearAlertStop =
      obs?.lat !== undefined &&
      obs.lng !== undefined &&
      distanceM({ lat: obs.lat, lng: obs.lng }, alertStop) <= TUNING.alertRadiusM;

    const byOrder = s.lastStopOrder >= alertOrder;
    const byProgress = s.progressM >= alertAt - TUNING.alertMarginM;
    const byEstimate = estimated >= alertAt - TUNING.alertMarginM;
    if (byOrder || byProgress || nearAlertStop || byEstimate) {
      s.phase = "alerted";
      events.push({
        type: "alert",
        stopsLeft: cfg.destOrder - s.lastStopOrder,
        estimated: !(byOrder || byProgress || nearAlertStop),
      });
    }
  }

  const stopsLeft = cfg.destOrder - s.lastStopOrder;
  const nextPollMs = stopsLeft > cfg.alertBefore + TUNING.farStops ? TUNING.farPollMs : TUNING.nearPollMs;
  return { state: s, events, nextPollMs };
}

export function cancel(prev: TripState): TripState {
  return prev.phase === "done" ? prev : { ...prev, phase: "done", doneReason: "cancelled" };
}
