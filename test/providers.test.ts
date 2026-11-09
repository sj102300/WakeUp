import { describe, expect, it } from "vitest";
import { ProviderError, list, validateStops } from "../src/providers/common";
import { parseGyeonggi } from "../src/providers/gyeonggi";
import { parseSeoul } from "../src/providers/seoul";
import { isTagoCity, parseTago } from "../src/providers/tago";
import { maskSecrets } from "../src/env";

// 응답 형태는 공개 명세 기준. M1 실측 응답으로 교체 예정.
describe("provider parsing", () => {
  it("단건 응답(객체)도 배열로 다룬다", () => {
    expect(list({ a: 1 })).toEqual([{ a: 1 }]);
    expect(list("")).toEqual([]);
  });

  it("TAGO 응답", () => {
    const one = { response: { header: { resultCode: "00" }, body: { items: { item: { nodeid: "A" } } } } };
    expect(parseTago(one)).toEqual([{ nodeid: "A" }]);
    expect(parseTago({ response: { header: { resultCode: "00" }, body: { items: "" } } })).toEqual([]);
    expect(() => parseTago({ response: { header: { resultCode: "30", resultMsg: "SERVICE_KEY" } } })).toThrow(ProviderError);
  });

  it("경기 응답", () => {
    const ok = { response: { msgHeader: { resultCode: 0 }, msgBody: { busRouteList: [{ routeId: 1 }] } } };
    expect(parseGyeonggi(ok, "busRouteList")).toHaveLength(1);
    expect(parseGyeonggi({ response: { msgHeader: { resultCode: 4 } } }, "busRouteList")).toEqual([]);
  });

  it("서울 응답", () => {
    expect(parseSeoul({ msgHeader: { headerCd: "0" }, msgBody: { itemList: [{ x: 1 }] } })).toHaveLength(1);
    expect(parseSeoul({ msgHeader: { headerCd: "4" }, msgBody: { itemList: null } })).toEqual([]);
    expect(() => parseSeoul({ msgHeader: { headerCd: "7", headerMsg: "key" } })).toThrow(ProviderError);
  });

  it("서울·경기 도시코드는 TAGO에서 제외", () => {
    expect(isTagoCity("31020")).toBe(false);
    expect(isTagoCity("23")).toBe(true);
  });

  it("정류장 검증: 좌표 이상·순번 중복 거부, 순번 정렬", () => {
    const s = (order: number, lat = 37.5) => ({ id: `${order}`, order, name: "", lat, lng: 127 });
    expect(validateStops([s(2), s(1)]).map((x) => x.order)).toEqual([1, 2]);
    expect(() => validateStops([s(1), s(2, 0)])).toThrow();
    expect(() => validateStops([s(1), s(1)])).toThrow();
  });

  it("키를 마스킹한다", () => {
    const env = { DATA_GO_KR_API_KEY: "abc+/=" };
    expect(maskSecrets("x?serviceKey=abc%2B%2F%3D&y=1", env)).toBe("x?serviceKey=***&y=1");
    expect(maskSecrets("err abc+/= here", env)).toBe("err *** here");
  });
});
