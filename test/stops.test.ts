import { describe, expect, it } from "vitest";
import { matchStop } from "../src/trip/stops";

const stops = [
  { id: "A", order: 1, name: "야탑역", lat: 37.411, lng: 127.128 },
  { id: "B2", order: 2, name: "서현역", lat: 37.385, lng: 127.123 },
];

describe("matchStop", () => {
  it("ID가 같으면 same", () => {
    expect(matchStop(stops, { id: "A", name: "야탑역", lat: 0, lng: 0 }).kind).toBe("same");
  });
  it("ID가 바뀌어도 이름이 같으면 moved", () => {
    expect(matchStop(stops, { id: "B", name: "서현역", lat: 37.3, lng: 127.1 })).toMatchObject({ kind: "moved", stop: { id: "B2" } });
  });
  it("200m 이내면 moved", () => {
    expect(matchStop(stops, { id: "X", name: "다른이름", lat: 37.4115, lng: 127.128 })).toMatchObject({ kind: "moved", stop: { id: "A" } });
  });
  it("없으면 missing", () => {
    expect(matchStop(stops, { id: "X", name: "없음", lat: 37.0, lng: 127.0 }).kind).toBe("missing");
  });
});
