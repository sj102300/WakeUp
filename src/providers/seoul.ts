import type { Env } from "../env";
import { type BusProvider, ProviderError, type RouteInfo, type Vehicle, fetchJson, list, num, requireKey, str, validateStops } from "./common";

// 서울시 버스정보 (ws.bus.go.kr). 필드명은 M1 실측으로 확정.
const BASE = "http://ws.bus.go.kr/api/rest";

interface SeoulResponse {
  msgHeader?: { headerCd?: string; headerMsg?: string };
  msgBody?: { itemList?: Record<string, unknown>[] | Record<string, unknown> | null };
}

export function parseSeoul(json: unknown): Record<string, unknown>[] {
  const r = json as SeoulResponse;
  const cd = str(r.msgHeader?.headerCd);
  // 4: 결과 없음
  if (cd === "4") return [];
  if (cd !== "0") throw new ProviderError(`seoul error ${cd}: ${str(r.msgHeader?.headerMsg)}`);
  return list(r.msgBody?.itemList);
}

export function seoulProvider(env: Partial<Env>): BusProvider {
  const key = () => requireKey(env.SEOUL_BUS_API_KEY ?? env.DATA_GO_KR_API_KEY, "SEOUL_BUS_API_KEY");
  const get = async (path: string, q: string) =>
    parseSeoul(await fetchJson(`${BASE}/${path}?serviceKey=${key()}&resultType=json&${q}`, env));

  return {
    id: "seoul",
    async searchRoutes(query) {
      const items = await get("busRouteInfo/getBusRouteList", `strSrch=${encodeURIComponent(query)}`);
      return items.map(
        (i): RouteInfo => ({
          key: `seoul:${str(i.busRouteId)}`,
          provider: "seoul",
          no: str(i.busRouteNm),
          start: str(i.stStationNm),
          end: str(i.edStationNm),
          region: "서울",
          type: str(i.routeType),
        }),
      );
    },
    async getRouteStops(id) {
      const items = await get("busRouteInfo/getStaionByRoute", `busRouteId=${encodeURIComponent(id)}`);
      return validateStops(
        items.map((i) => ({
          id: str(i.station),
          order: Number(i.seq),
          name: str(i.stationNm),
          lat: Number(i.gpsY),
          lng: Number(i.gpsX),
        })),
      );
    },
    async getVehicles(id) {
      const items = await get("buspos/getBusPosByRtid", `busRouteId=${encodeURIComponent(id)}`);
      return items.map(
        (i): Vehicle => ({
          vehicleNo: str(i.plainNo) || str(i.vehId),
          stopOrder: Number(i.sectOrd),
          lat: num(i.gpsY),
          lng: num(i.gpsX),
        }),
      );
    },
  };
}
