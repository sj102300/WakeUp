export interface LatLng {
  lat: number;
  lng: number;
}

const R = 6371000;
const rad = (d: number) => (d * Math.PI) / 180;

export function distanceM(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** p를 선분 a→b에 투영했을 때 a로부터의 비율(0~1). 짧은 구간이라 평면 근사. */
export function projectRatio(p: LatLng, a: LatLng, b: LatLng): number {
  const k = Math.cos(rad(a.lat));
  const ax = a.lng * k, ay = a.lat;
  const bx = b.lng * k - ax, by = b.lat - ay;
  const px = p.lng * k - ax, py = p.lat - ay;
  const len2 = bx * bx + by * by;
  if (len2 === 0) return 0;
  return Math.min(1, Math.max(0, (px * bx + py * by) / len2));
}
