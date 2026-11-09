import { describe, expect, it } from "vitest";
import { Route, TUNING, initialState, step, type Stop, type TripConfig, type VehicleObs } from "../src/trip/engine";

// 위도 방향으로 약 400m 간격의 직선 노선 10개 정류장
const stops: Stop[] = Array.from({ length: 10 }, (_, i) => ({
  id: `S${i + 1}`,
  order: i + 1,
  name: `정류장${i + 1}`,
  lat: 37.4 + i * 0.0036,
  lng: 127.1,
}));
const route = new Route(stops);
const cfg: TripConfig = { stops, boardOrder: 1, destOrder: 8, alertBefore: 2, startedAt: 0 };
const at = (order: number, frac = 0): VehicleObs => ({
  vehicleNo: "경기70바1234",
  stopOrder: order,
  lat: 37.4 + (order - 1 + frac) * 0.0036,
  lng: 127.1,
});

function run(seq: Array<VehicleObs | null>, intervalMs = 20_000) {
  let s = initialState(cfg, route);
  const log: Array<{ t: number; events: ReturnType<typeof step>["events"] }> = [];
  seq.forEach((obs, i) => {
    const t = (i + 1) * intervalMs;
    const r = step(cfg, route, s, obs, t);
    s = r.state;
    if (r.events.length) log.push({ t, events: r.events });
  });
  return { state: s, log };
}

describe("trip engine", () => {
  it("목적지 2정거장 전에 한 번만 알린다", () => {
    const { log } = run([at(2), at(3), at(4), at(5), at(6), at(6), at(7)]);
    const alerts = log.flatMap((l) => l.events).filter((e) => e.type === "alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ stopsLeft: 2, estimated: false });
  });

  it("알림 정류장 반경에 들어오면 순번 갱신 전이라도 알린다", () => {
    const { log } = run([at(3), at(5, 0.7)]);
    expect(log.at(-1)?.events[0]).toMatchObject({ type: "alert" });
  });

  it("관측이 멈춰도 속도 추정으로 알린다", () => {
    const { log } = run([at(4), at(5), at(5, 0.6), at(5, 0.6), at(5, 0.6), at(5, 0.6)]);
    const alert = log.flatMap((l) => l.events).find((e) => e.type === "alert");
    expect(alert).toMatchObject({ estimated: true });
  });

  it("정류장을 건너뛰어도 알림과 도착을 놓치지 않는다", () => {
    const { log, state } = run([at(3), at(7), at(9)]);
    const types = log.flatMap((l) => l.events).map((e) => e.type);
    expect(types).toEqual(["alert", "done"]);
    expect(state.doneReason).toBe("arrived");
  });

  it("차량이 3회 연속 사라지면 추적을 끝낸다", () => {
    const { state } = run([at(2), null, null, null]);
    expect(state.phase).toBe("done");
    expect(state.doneReason).toBe("lost");
  });

  it("GPS가 뒤로 튀어도 진행 거리는 줄지 않는다", () => {
    const { state } = run([at(4, 0.5), at(4, 0.1)]);
    expect(state.progressM).toBeGreaterThan(route.at(4) + 100);
  });

  it("최대 시간을 넘으면 종료한다", () => {
    const s = initialState(cfg, route);
    const r = step(cfg, route, s, at(2), TUNING.maxTripMs + 1);
    expect(r.state.doneReason).toBe("timeout");
    expect(r.nextPollMs).toBeNull();
  });

  it("멀면 60초, 가까우면 20초 간격으로 조회한다", () => {
    const far = { ...cfg, destOrder: 10 };
    const s = initialState(far, route);
    expect(step(far, route, s, at(2), 1000).nextPollMs).toBe(TUNING.farPollMs);
    expect(step(far, route, s, at(3), 1000).nextPollMs).toBe(TUNING.nearPollMs);
  });
});
