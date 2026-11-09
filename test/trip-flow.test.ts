import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RouteInfo } from "../src/providers";

// 경기 노선 가짜 응답: 직선 노선 정류장 8개, 차량 1대가 순서대로 이동
const stops = Array.from({ length: 8 }, (_, i) => ({
  stationId: `ST${i + 1}`,
  stationSeq: i + 1,
  stationName: `정류장${i + 1}`,
  y: 37.4 + i * 0.0036,
  x: 127.1,
}));
let busAt = 1;
const pushes: string[] = [];

function mockFetch() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    const ok = (msgBody: unknown) =>
      new Response(JSON.stringify({ response: { msgHeader: { resultCode: 0 }, msgBody } }));
    if (url.includes("getBusRouteStationListv2")) return ok({ busRouteStationList: stops });
    if (url.includes("getBusLocationListv2"))
      return ok({ busLocationList: busAt > 0 ? { plateNo: "경기70바1234", stationSeq: busAt } : [] });
    if (url.startsWith("https://push.example/")) {
      pushes.push(url);
      return new Response(null, { status: 201 });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

const route: RouteInfo = { key: "gyeonggi:R1", provider: "gyeonggi", no: "9407", start: "A", end: "B", region: "성남" };

afterEach(() => {
  vi.restoreAllMocks();
  pushes.length = 0;
});

describe("API 인증", () => {
  it("로그인 없이는 401, 로그인 후 접근 가능", async () => {
    expect((await SELF.fetch("https://x/api/trip")).status).toBe(401);
    const bad = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ token: "nope" }) });
    expect(bad.status).toBe(401);
    const login = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ token: "test-token" }) });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    expect(cookie).not.toContain("test-token");
    const res = await SELF.fetch("https://x/api/trip", { headers: { cookie } });
    expect(res.status).toBe(200);
  });

  it("health는 누락된 비밀값 이름만 보여준다", async () => {
    const res = await (await SELF.fetch("https://x/api/health")).json<{ missingSecrets: string[] }>();
    expect(res.missingSecrets).toEqual([]);
  });
});

describe("트립 흐름", () => {
  it("탑승 → 알림 → 도착 시 알람이 해제된다", async () => {
    mockFetch();
    busAt = 1;
    const stub = env.APP.get(env.APP.idFromName("flow"));
    // 푸시 구독 없이 진행 (notify는 no subscription으로 통과)
    const started = await stub.startTrip({ route, boardStopId: "ST1", destStopId: "ST6", alertBefore: 2, vehicleNo: "경기70바1234" });
    expect(started.trip?.stopsLeft).toBe(5);

    const phases: string[] = [];
    for (const at of [2, 3, 4, 5, 6]) {
      busAt = at;
      await runDurableObjectAlarm(stub);
      const t = await stub.trip();
      phases.push(t ? `${at}:${t.phase}` : `${at}:ended`);
    }
    expect(phases).toEqual(["2:tracking", "3:tracking", "4:alerted", "5:alerted", "6:ended"]);

    await runInDurableObject(stub, async (_obj, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
    });
    const [summary] = await stub.history();
    expect(summary.reason).toBe("arrived");
    const log = await stub.tripLog(summary.id);
    expect(log.log.some((e) => e.events?.some((ev) => ev.type === "alert"))).toBe(true);
  });

  it("차량이 사라지면 3회 후 종료", async () => {
    mockFetch();
    busAt = 2;
    const stub = env.APP.get(env.APP.idFromName("lost"));
    await stub.startTrip({ route, boardStopId: "ST1", destStopId: "ST8", alertBefore: 1, vehicleNo: "경기70바1234" });
    busAt = 0;
    for (let i = 0; i < 3; i++) await runDurableObjectAlarm(stub);
    expect(await stub.trip()).toBeNull();
    expect((await stub.history())[0].reason).toBe("lost");
  });

  it("직접 종료하면 알람이 해제된다", async () => {
    mockFetch();
    busAt = 1;
    const stub = env.APP.get(env.APP.idFromName("cancel"));
    await stub.startTrip({ route, boardStopId: "ST1", destStopId: "ST8", alertBefore: 1, vehicleNo: "경기70바1234" });
    await stub.cancelTrip();
    expect(await stub.trip()).toBeNull();
    expect(await runDurableObjectAlarm(stub)).toBe(false);
  });

  it("목적지가 탑승 정류장보다 앞이면 거부", async () => {
    mockFetch();
    const login = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ token: "test-token" }) });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const res = await SELF.fetch("https://x/api/trip", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ route, boardStopId: "ST5", destStopId: "ST2", alertBefore: 1, vehicleNo: "x" }),
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "목적지는 탑승 정류장보다 뒤여야 합니다" });
  });

  it("노선 캐시: 갱신 실패 시 저장된 정류장을 쓴다", async () => {
    const spy = mockFetch();
    const stub = env.APP.get(env.APP.idFromName("cache"));
    await stub.getStops("gyeonggi:R1");
    await runInDurableObject(stub, async (_o, state) => {
      const c = await state.storage.get<{ fetchedAt: number }>("stops:gyeonggi:R1");
      await state.storage.put("stops:gyeonggi:R1", { ...c, fetchedAt: 0 });
    });
    spy.mockImplementation(async () => new Response("boom", { status: 500 }));
    const r = await stub.getStops("gyeonggi:R1");
    expect(r.stale).toBe(true);
    expect(r.stops).toHaveLength(8);
  });
});
