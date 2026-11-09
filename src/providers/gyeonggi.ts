import type { Env } from "../env";
import { type BusProvider, ProviderError, type RouteInfo, type Vehicle, fetchJson, list, num, requireKey, str, validateStops } from "./common";

// 경기도 버스정보 GBIS v2 (공공데이터포털). 필드명은 M1 실측으로 확정.
const BASE = "https://apis.data.go.kr/6410000";

interface GgResponse {
  response?: {
    msgHeader?: { resultCode?: number | string; resultMessage?: string };
    msgBody?: Record<string, unknown>;
  };
}

export function parseGyeonggi(json: unknown, field: string): Record<string, unknown>[] {
  const r = (json as GgResponse).response;
  const cd = str(r?.msgHeader?.resultCode);
  // 4: 결과 없음
  if (cd === "4") return [];
  if (cd !== "0") throw new ProviderError(`gyeonggi error ${cd}: ${str(r?.msgHeader?.resultMessage)}`);
  return list(r?.msgBody?.[field] as Record<string, unknown>[] | undefined);
}

export function gyeonggiProvider(env: Partial<Env>): BusProvider {
  const get = async (path: string, q: string, field: string) =>
    parseGyeonggi(
      await fetchJson(`${BASE}/${path}?serviceKey=${requireKey(env.DATA_GO_KR_API_KEY, "DATA_GO_KR_API_KEY")}&format=json&${q}`, env),
      field,
    );

  return {
    id: "gyeonggi",
    async searchRoutes(query) {
      const items = await get("busrouteservice/v2/getBusRouteListv2", `keyword=${encodeURIComponent(query)}`, "busRouteList");
      return (
        items
          // 경기도 면허 노선만 (districtCd 1=서울, 2=경기, 3=인천). 서울·인천 노선은 각 공급자가 담당.
          .filter((i) => str(i.districtCd) === "" || str(i.districtCd) === "2")
          .map(
            (i): RouteInfo => ({
              key: `gyeonggi:${str(i.routeId)}`,
              provider: "gyeonggi",
              no: str(i.routeName),
              start: str(i.startStationName),
              end: str(i.endStationName),
              region: str(i.regionName) || "경기",
              type: str(i.routeTypeName),
            }),
          )
      );
    },
    async getRouteStops(id) {
      const items = await get("busrouteservice/v2/getBusRouteStationListv2", `routeId=${encodeURIComponent(id)}`, "busRouteStationList");
      return validateStops(
        items.map((i) => ({
          id: str(i.stationId),
          order: Number(i.stationSeq),
          name: str(i.stationName),
          lat: Number(i.y),
          lng: Number(i.x),
        })),
      );
    },
    async getVehicles(id) {
      const items = await get("buslocationservice/v2/getBusLocationListv2", `routeId=${encodeURIComponent(id)}`, "busLocationList");
      return items.map(
        (i): Vehicle => ({
          vehicleNo: str(i.plateNo),
          stopOrder: Number(i.stationSeq),
          lat: num(i.y),
          lng: num(i.x),
        }),
      );
    },
  };
}
