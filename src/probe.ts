import { type Env, maskSecrets } from "./env";

// 공공 API가 Cloudflare 출구 IP에서 접근 가능한지 확인한다.
// 키가 없어도 "키 미등록" 응답이 오면 네트워크는 열려 있는 것이다.
const TARGETS = [
  {
    name: "tago",
    url: (k: string) =>
      `https://apis.data.go.kr/1613000/BusRouteInfoInqireService/getCtyCodeList?serviceKey=${k}&_type=json`,
    key: (e: Env) => e.DATA_GO_KR_API_KEY,
  },
  {
    name: "gyeonggi",
    url: (k: string) =>
      `https://apis.data.go.kr/6410000/busrouteservice/v2/getBusRouteListv2?serviceKey=${k}&keyword=1&format=json`,
    key: (e: Env) => e.DATA_GO_KR_API_KEY,
  },
  {
    name: "seoul",
    url: (k: string) =>
      `http://ws.bus.go.kr/api/rest/busRouteInfo/getBusRouteList?serviceKey=${k}&strSrch=1&resultType=json`,
    key: (e: Env) => e.SEOUL_BUS_API_KEY ?? e.DATA_GO_KR_API_KEY,
  },
];

export async function probe(env: Env) {
  return Promise.all(
    TARGETS.map(async (t) => {
      const raw = t.key(env);
      const started = Date.now();
      try {
        const res = await fetch(t.url(encodeURIComponent(raw ?? "none")), {
          signal: AbortSignal.timeout(8000),
        });
        const body = await res.text();
        return {
          name: t.name,
          hasKey: Boolean(raw),
          status: res.status,
          ms: Date.now() - started,
          body: maskSecrets(body.slice(0, 400), env),
        };
      } catch (e) {
        return { name: t.name, hasKey: Boolean(raw), error: String(e), ms: Date.now() - started };
      }
    }),
  );
}
