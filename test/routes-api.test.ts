import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

const stops = [1, 2, 3].map((i) => ({ stationId: `ST${i}`, stationSeq: i, stationName: `정류장${i}`, y: 37.4 + i * 0.003, x: 127.1 }));

async function login() {
  const res = await SELF.fetch("https://x/api/login", { method: "POST", body: JSON.stringify({ token: "test-token" }) });
  return res.headers.get("set-cookie")!.split(";")[0];
}

afterEach(() => vi.restoreAllMocks());

describe("노선 API", () => {
  it("인코딩된 노선 키로 정류장을 불러오고 즐겨찾기를 저장한다", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ response: { msgHeader: { resultCode: 0 }, msgBody: { busRouteStationList: stops } } })),
    );
    const cookie = await login();
    const key = encodeURIComponent("gyeonggi:R9");
    const res = await SELF.fetch(`https://x/api/routes/${key}/stops`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect((await res.json<{ stops: unknown[] }>()).stops).toHaveLength(3);

    const route = { key: "gyeonggi:R9", provider: "gyeonggi", no: "9", start: "a", end: "b", region: "성남" };
    const fav = await SELF.fetch("https://x/api/favorites", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ route, boardStopId: "ST1", destStopId: "ST3", alertBefore: 1 }),
    });
    expect(fav.status).toBe(200);
  });
});
