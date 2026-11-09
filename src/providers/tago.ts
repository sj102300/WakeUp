import type { Env } from "../env";
import { type BusProvider, ProviderError, type RouteInfo, type Vehicle, fetchJson, list, num, requireKey, str, validateStops } from "./common";

// 국토교통부 TAGO. 노선은 도시코드가 필요하므로 ID를 "<cityCode>:<routeId>"로 다룬다.
const BASE = "https://apis.data.go.kr/1613000";

interface TagoResponse {
  response?: {
    header?: { resultCode?: string; resultMsg?: string };
    body?: { items?: { item?: Record<string, unknown>[] | Record<string, unknown> } | "" };
  };
}

export function parseTago(json: unknown): Record<string, unknown>[] {
  const r = (json as TagoResponse).response;
  const cd = str(r?.header?.resultCode);
  if (cd !== "00") throw new ProviderError(`tago error ${cd}: ${str(r?.header?.resultMsg)}`);
  const items = r?.body?.items;
  return items ? list(items.item) : [];
}

/** 서울·경기는 전용 공급자가 담당하므로 TAGO에서 제외 */
export function isTagoCity(cityCode: string): boolean {
  const c = Number(cityCode);
  return !(c >= 31000 && c < 32000) && c !== 11;
}

export function tagoProvider(env: Partial<Env>): BusProvider & { cities(): Promise<{ code: string; name: string }[]> } {
  const get = async (path: string, q: string) =>
    parseTago(
      await fetchJson(
        `${BASE}/${path}?serviceKey=${requireKey(env.DATA_GO_KR_API_KEY, "DATA_GO_KR_API_KEY")}&_type=json&numOfRows=1000&${q}`,
        env,
      ),
    );
  const split = (id: string) => {
    const [city, route] = id.split(":");
    if (!city || !route) throw new ProviderError(`invalid tago route id ${id}`);
    return { city: encodeURIComponent(city), route: encodeURIComponent(route) };
  };

  return {
    id: "tago",
    async cities() {
      const items = await get("BusRouteInfoInqireService/getCtyCodeList", "");
      return items
        .map((i) => ({ code: str(i.citycode), name: str(i.cityname) }))
        .filter((c) => isTagoCity(c.code));
    },
    async searchRoutes(query, region) {
      if (!region) return [];
      const items = await get(
        "BusRouteInfoInqireService/getRouteNoList",
        `cityCode=${encodeURIComponent(region)}&routeNo=${encodeURIComponent(query)}`,
      );
      return items.map(
        (i): RouteInfo => ({
          key: `tago:${region}:${str(i.routeid)}`,
          provider: "tago",
          no: str(i.routeno),
          start: str(i.startnodenm),
          end: str(i.endnodenm),
          region,
          type: str(i.routetp),
        }),
      );
    },
    async getRouteStops(id) {
      const { city, route } = split(id);
      const items = await get("BusRouteInfoInqireService/getRouteAcctoThrghSttnList", `cityCode=${city}&routeId=${route}`);
      return validateStops(
        items.map((i) => ({
          id: str(i.nodeid),
          order: Number(i.nodeord),
          name: str(i.nodenm),
          lat: Number(i.gpslati),
          lng: Number(i.gpslong),
        })),
      );
    },
    async getVehicles(id) {
      const { city, route } = split(id);
      const items = await get("BusLcInfoInqireService/getRouteAcctoBusLcList", `cityCode=${city}&routeId=${route}`);
      return items.map(
        (i): Vehicle => ({
          vehicleNo: str(i.vehicleno),
          stopOrder: Number(i.nodeord),
          lat: num(i.gpslati),
          lng: num(i.gpslong),
        }),
      );
    },
  };
}
