import { DurableObject } from "cloudflare:workers";
import { type Env, maskSecrets } from "../env";
import { probe, summarize } from "../probe";
import { type RouteInfo, providers, resolve } from "../providers";
import { type PushSubscriptionJSON, type Vapid, sendPush } from "../push/webpush";
import { Route, type Stop, type TripConfig, type TripEvent, type TripState, type VehicleObs, cancel, initialState, step } from "../trip/engine";
import { distanceM } from "../trip/geo";
import { type SavedStop, matchStop, toSaved } from "../trip/stops";

const STOPS_TTL_MS = 3 * 24 * 3600 * 1000;
const REGIONS_TTL_MS = 30 * 24 * 3600 * 1000;
const FIRST_POLL_MS = 5_000;
const MAX_ERRORS = 10;
const LOG_LIMIT = 600;
const HISTORY_LIMIT = 30;

interface CachedStops {
  stops: Stop[];
  fetchedAt: number;
}

export interface Favorite {
  id: string;
  route: RouteInfo;
  board: SavedStop;
  dest: SavedStop;
  alertBefore: number;
}

export interface StartTripInput {
  route: RouteInfo;
  boardStopId: string;
  destStopId: string;
  alertBefore: number;
  vehicleNo: string;
}

interface ActiveTrip {
  id: string;
  route: RouteInfo;
  board: Stop;
  dest: Stop;
  vehicleNo: string;
  cfg: TripConfig;
  state: TripState;
  errors: number;
  lastObs?: VehicleObs & { at: number };
}

interface LogEntry {
  t: number;
  obs?: VehicleObs | null;
  error?: string;
  events?: TripEvent[];
  gps?: { lat: number; lng: number; acc: number };
}

interface TripMeta {
  route: RouteInfo;
  board: Stop;
  dest: Stop;
  vehicleNo: string;
  cfg: TripConfig;
}

export interface TripSummary {
  id: string;
  routeNo: string;
  board: string;
  dest: string;
  startedAt: number;
  endedAt: number;
  reason: string;
}

/** 1인용 앱 전체 상태. 이름 "me"인 인스턴스 하나만 쓴다. */
export class AppObject extends DurableObject<Env> {
  private get kv() {
    return this.ctx.storage;
  }

  // ---------- 노선 데이터 ----------

  async getStops(routeKey: string): Promise<{ stops: Stop[]; fetchedAt: number; stale: boolean }> {
    const cached = await this.kv.get<CachedStops>(`stops:${routeKey}`);
    if (cached && Date.now() - cached.fetchedAt < STOPS_TTL_MS) return { ...cached, stale: false };
    try {
      const { provider, id } = resolve(this.env, routeKey);
      const fresh = { stops: await provider.getRouteStops(id), fetchedAt: Date.now() };
      await this.kv.put(`stops:${routeKey}`, fresh);
      return { ...fresh, stale: false };
    } catch (e) {
      // 갱신 실패 시 캐시 유지
      if (cached) return { ...cached, stale: true };
      throw e;
    }
  }

  async regions(): Promise<{ code: string; name: string }[]> {
    const cached = await this.kv.get<{ list: { code: string; name: string }[]; fetchedAt: number }>("regions");
    if (cached && Date.now() - cached.fetchedAt < REGIONS_TTL_MS) return cached.list;
    try {
      const list = await providers(this.env).tago.cities();
      await this.kv.put("regions", { list, fetchedAt: Date.now() });
      return list;
    } catch (e) {
      if (cached) return cached.list;
      throw e;
    }
  }

  /** 탑승 차량 후보: 폰 위치와 가까운 순. 300m 이내 + 탑승 정류장 ±1이면 matched. */
  async candidates(routeKey: string, boardStopId: string, lat?: number, lng?: number) {
    const { stops } = await this.getStops(routeKey);
    const board = stops.find((s) => s.id === boardStopId);
    if (!board) throw new Error("탑승 정류장을 노선에서 찾을 수 없습니다");
    const { provider, id } = resolve(this.env, routeKey);
    const vehicles = await provider.getVehicles(id);
    const here = lat !== undefined && lng !== undefined ? { lat, lng } : board;
    return vehicles
      .map((v) => {
        const pos = v.lat !== undefined && v.lng !== undefined ? { lat: v.lat, lng: v.lng } : stops.find((s) => s.order === v.stopOrder);
        const d = pos ? Math.round(distanceM(here, pos)) : undefined;
        const stop = stops.find((s) => s.order === v.stopOrder);
        return {
          vehicleNo: v.vehicleNo,
          stopOrder: v.stopOrder,
          stopName: stop?.name ?? "",
          distanceM: d,
          matched: d !== undefined && d <= 300 && Math.abs(v.stopOrder - board.order) <= 1,
        };
      })
      .sort((a, b) => (a.distanceM ?? 1e9) - (b.distanceM ?? 1e9));
  }

  /** 공공 API 도달 여부 (10분 캐시, 공개 엔드포인트 남용 방지) */
  async diag() {
    const cached = await this.kv.get<{ at: number; result: ReturnType<typeof summarize> }>("diag");
    if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached;
    const fresh = { at: Date.now(), result: summarize(await probe(this.env)) };
    await this.kv.put("diag", fresh);
    return fresh;
  }

  // ---------- 즐겨찾기 ----------

  async favorites(): Promise<Favorite[]> {
    return (await this.kv.get<Favorite[]>("favorites")) ?? [];
  }

  async addFavorite(input: Omit<Favorite, "id" | "board" | "dest"> & { boardStopId: string; destStopId: string }) {
    const { stops } = await this.getStops(input.route.key);
    const board = stops.find((s) => s.id === input.boardStopId);
    const dest = stops.find((s) => s.id === input.destStopId);
    if (!board || !dest) throw new Error("정류장을 찾을 수 없습니다");
    const fav: Favorite = {
      id: crypto.randomUUID(),
      route: input.route,
      board: toSaved(board),
      dest: toSaved(dest),
      alertBefore: input.alertBefore,
    };
    await this.kv.put("favorites", [...(await this.favorites()), fav]);
    return fav;
  }

  async removeFavorite(id: string) {
    await this.kv.put("favorites", (await this.favorites()).filter((f) => f.id !== id));
  }

  /** 즐겨찾기 정류장을 최신 노선 데이터와 대조. 변경 시 자동 반영(same) 또는 확인 필요(moved/missing). */
  async resolveFavorite(id: string) {
    const fav = (await this.favorites()).find((f) => f.id === id);
    if (!fav) throw new Error("즐겨찾기가 없습니다");
    const { stops, stale } = await this.getStops(fav.route.key);
    const board = matchStop(stops, fav.board);
    const dest = matchStop(stops, fav.dest);
    if (board.kind === "same" && dest.kind === "same") {
      // 좌표·이름 변경은 묻지 않고 반영
      const updated = { ...fav, board: toSaved(board.stop), dest: toSaved(dest.stop) };
      await this.kv.put("favorites", (await this.favorites()).map((f) => (f.id === id ? updated : f)));
    }
    return { favorite: fav, board, dest, stale };
  }

  // ---------- 푸시 ----------

  async saveSubscription(sub: PushSubscriptionJSON) {
    await this.kv.put("sub", sub);
  }

  async hasSubscription() {
    return Boolean(await this.kv.get("sub"));
  }

  private vapid(): Vapid {
    const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = this.env;
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) throw new Error("VAPID secrets are not set");
    return { publicKey: VAPID_PUBLIC_KEY, privateKey: VAPID_PRIVATE_KEY, subject: VAPID_SUBJECT || "mailto:wakeup@example.com" };
  }

  async notify(title: string, body: string, tag = "trip") {
    const sub = await this.kv.get<PushSubscriptionJSON>("sub");
    if (!sub) return { ok: false, reason: "no subscription" };
    const r = await sendPush(sub, { title, body, tag }, this.vapid());
    if (!r.ok && r.gone) await this.kv.delete("sub");
    return r.ok ? { ok: true } : { ok: false, reason: `push ${r.status}` };
  }

  // ---------- 트립 ----------

  async trip() {
    const t = await this.kv.get<ActiveTrip>("trip");
    if (!t) return null;
    return {
      id: t.id,
      route: t.route,
      board: t.board,
      dest: t.dest,
      vehicleNo: t.vehicleNo,
      alertBefore: t.cfg.alertBefore,
      phase: t.state.phase,
      stopsLeft: t.dest.order - t.state.lastStopOrder,
      lastObs: t.lastObs,
      startedAt: t.cfg.startedAt,
    };
  }

  async startTrip(input: StartTripInput) {
    if (await this.kv.get("trip")) await this.endTrip("cancelled");
    const { stops } = await this.getStops(input.route.key);
    const board = stops.find((s) => s.id === input.boardStopId);
    const dest = stops.find((s) => s.id === input.destStopId);
    if (!board || !dest) throw new Error("정류장을 노선에서 찾을 수 없습니다");
    if (dest.order <= board.order) throw new Error("목적지는 탑승 정류장보다 뒤여야 합니다");
    const now = Date.now();
    const cfg: TripConfig = {
      stops,
      boardOrder: board.order,
      destOrder: dest.order,
      alertBefore: Math.max(1, Math.min(3, Math.round(input.alertBefore))),
      startedAt: now,
    };
    const trip: ActiveTrip = {
      id: `${now}`,
      route: input.route,
      board,
      dest,
      vehicleNo: input.vehicleNo,
      cfg,
      state: initialState(cfg, new Route(stops)),
      errors: 0,
    };
    await this.kv.put("trip", trip);
    await this.kv.put(`log:${trip.id}`, [] as LogEntry[]);
    await this.kv.put(`meta:${trip.id}`, { route: input.route, board, dest, vehicleNo: input.vehicleNo, cfg } satisfies TripMeta);
    await this.ctx.storage.setAlarm(now + FIRST_POLL_MS);
    const push = await this.notify(
      "추적 시작",
      `${input.route.no}번 ${dest.name} 하차 · ${cfg.alertBefore}정거장 전에 알려드릴게요`,
    );
    return { trip: await this.trip(), push };
  }

  async cancelTrip() {
    const t = await this.kv.get<ActiveTrip>("trip");
    if (!t) return;
    t.state = cancel(t.state);
    await this.kv.put("trip", t);
    await this.endTrip("cancelled");
  }

  /** 폰이 화면을 켜둔 동안 보내는 GPS (M1 실측 비교용 기록) */
  async addGps(lat: number, lng: number, acc: number) {
    const t = await this.kv.get<ActiveTrip>("trip");
    if (!t) return;
    await this.appendLog(t.id, { t: Date.now(), gps: { lat, lng, acc } });
  }

  async alarm() {
    const t = await this.kv.get<ActiveTrip>("trip");
    if (!t) return;
    const now = Date.now();
    const route = new Route(t.cfg.stops);
    let obs: VehicleObs | null;
    try {
      const { provider, id } = resolve(this.env, t.route.key);
      obs = (await provider.getVehicles(id)).find((v) => v.vehicleNo === t.vehicleNo) ?? null;
      t.errors = 0;
    } catch (e) {
      // 네트워크·API 오류는 차량 소실로 세지 않고 재시도
      t.errors += 1;
      await this.appendLog(t.id, { t: now, error: maskSecrets(String(e), this.env) });
      if (t.errors >= MAX_ERRORS) {
        await this.kv.put("trip", t);
        await this.notify("추적 중단", "버스 정보를 계속 받지 못해 추적을 끝냈어요");
        return this.endTrip("lost");
      }
      await this.kv.put("trip", t);
      await this.ctx.storage.setAlarm(now + 20_000);
      return;
    }

    const r = step(t.cfg, route, t.state, obs, now);
    t.state = r.state;
    if (obs) t.lastObs = { ...obs, at: now };
    await this.kv.put("trip", t);
    await this.appendLog(t.id, { t: now, obs, events: r.events.length ? r.events : undefined });

    for (const e of r.events) {
      if (e.type === "alert") {
        await this.notify(
          `${e.stopsLeft}정거장 뒤 하차`,
          `${t.dest.name}에서 내리세요${e.estimated ? " (예상 위치 기준)" : ""}`,
          "alert",
        );
      } else if (e.reason === "arrived") {
        await this.notify("목적지 도착", `${t.dest.name} · 추적을 종료했어요`);
      } else if (e.reason === "lost") {
        await this.notify("추적 끊김", "버스 위치를 찾을 수 없어 추적을 끝냈어요");
      } else if (e.reason === "timeout") {
        await this.notify("추적 종료", "최대 시간이 지나 추적을 끝냈어요");
      }
    }

    if (r.nextPollMs === null) return this.endTrip(t.state.doneReason ?? "arrived");
    await this.ctx.storage.setAlarm(now + r.nextPollMs);
  }

  private async endTrip(reason: string) {
    const t = await this.kv.get<ActiveTrip>("trip");
    await this.ctx.storage.deleteAlarm();
    if (!t) return;
    await this.kv.delete("trip");
    const summary: TripSummary = {
      id: t.id,
      routeNo: t.route.no,
      board: t.board.name,
      dest: t.dest.name,
      startedAt: t.cfg.startedAt,
      endedAt: Date.now(),
      reason,
    };
    const history = [summary, ...((await this.kv.get<TripSummary[]>("history")) ?? [])];
    for (const old of history.slice(HISTORY_LIMIT)) await this.kv.delete([`log:${old.id}`, `meta:${old.id}`]);
    await this.kv.put("history", history.slice(0, HISTORY_LIMIT));
  }

  private async appendLog(id: string, e: LogEntry) {
    const log = (await this.kv.get<LogEntry[]>(`log:${id}`)) ?? [];
    log.push(e);
    await this.kv.put(`log:${id}`, log.slice(-LOG_LIMIT));
  }

  async history() {
    return (await this.kv.get<TripSummary[]>("history")) ?? [];
  }

  async tripLog(id: string) {
    return { meta: (await this.kv.get<TripMeta>(`meta:${id}`)) ?? null, log: (await this.kv.get<LogEntry[]>(`log:${id}`)) ?? [] };
  }
}
