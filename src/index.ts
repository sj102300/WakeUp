import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { type Env, REQUIRED_SECRETS, maskSecrets } from "./env";
import { probe } from "./probe";
import { type RouteInfo, searchRoutes } from "./providers";
import { b64url } from "./push/webpush";
import { serveStatic } from "./static";

export { AppObject } from "./objects/app";

const COOKIE = "wakeup_session";
const app = new Hono<{ Bindings: Env }>();
const me = (env: Env) => env.APP.get(env.APP.idFromName("me"));

async function sessionValue(token: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("wakeup-session-v1")));
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

app.onError((err, c) => c.json({ error: maskSecrets(err.message, c.env) }, 500));

app.get("/api/health", (c) =>
  c.json({ ok: true, missingSecrets: REQUIRED_SECRETS.filter((k) => !c.env[k]) }),
);

app.get("/api/diag", async (c) => c.json(await me(c.env).diag()));

app.post("/api/login", async (c) => {
  const { token } = await c.req.json<{ token?: string }>();
  if (!c.env.APP_ACCESS_TOKEN || !token || !safeEqual(token, c.env.APP_ACCESS_TOKEN)) {
    return c.json({ error: "토큰이 맞지 않습니다" }, 401);
  }
  setCookie(c, COOKIE, await sessionValue(c.env.APP_ACCESS_TOKEN), {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/",
    maxAge: 400 * 24 * 3600,
  });
  return c.json({ ok: true });
});

// 이하 모든 API는 로그인 필요
app.use("/api/*", async (c, next) => {
  const token = c.env.APP_ACCESS_TOKEN;
  const cookie = getCookie(c, COOKIE);
  if (!token || !cookie || !safeEqual(cookie, await sessionValue(token))) return c.json({ error: "unauthorized" }, 401);
  await next();
});

app.post("/api/logout", (c) => {
  deleteCookie(c, COOKIE, { path: "/" });
  return c.json({ ok: true });
});

app.get("/api/probe", async (c) => c.json(await probe(c.env)));

app.get("/api/regions", async (c) => c.json(await me(c.env).regions()));

app.get("/api/routes", async (c) => {
  const q = c.req.query("q")?.trim();
  if (!q) return c.json({ routes: [], errors: [] });
  const region = c.req.query("region") || undefined;
  const result = await searchRoutes(c.env, q, region);
  if (region) {
    // TAGO는 도시코드만 주므로 도시 이름으로 바꿔 표시
    const name = (await me(c.env).regions().catch(() => [])).find((r) => r.code === region)?.name;
    if (name) for (const r of result.routes) r.region = name;
  }
  return c.json(result);
});

app.get("/api/routes/:key/stops", async (c) => c.json(await me(c.env).getStops(c.req.param("key"))));

app.get("/api/routes/:key/vehicles", async (c) => {
  const lat = c.req.query("lat"), lng = c.req.query("lng");
  return c.json(
    await me(c.env).candidates(
      c.req.param("key"),
      c.req.query("board") ?? "",
      lat ? Number(lat) : undefined,
      lng ? Number(lng) : undefined,
    ),
  );
});

app.get("/api/push/key", (c) => c.json({ publicKey: c.env.VAPID_PUBLIC_KEY ?? null }));
app.post("/api/push/subscribe", async (c) => {
  await me(c.env).saveSubscription(await c.req.json());
  return c.json({ ok: true });
});
app.get("/api/push/status", async (c) => c.json({ subscribed: await me(c.env).hasSubscription() }));
app.post("/api/push/test", async (c) => c.json(await me(c.env).notify("테스트 알림", "알림이 잘 도착했어요", "test")));

app.get("/api/favorites", async (c) => c.json(await me(c.env).favorites()));
app.post("/api/favorites", async (c) =>
  c.json(
    await me(c.env).addFavorite(
      await c.req.json<{ route: RouteInfo; boardStopId: string; destStopId: string; alertBefore: number }>(),
    ),
  ),
);
app.delete("/api/favorites/:id", async (c) => {
  await me(c.env).removeFavorite(c.req.param("id"));
  return c.json({ ok: true });
});
app.get("/api/favorites/:id/resolve", async (c) => c.json(await me(c.env).resolveFavorite(c.req.param("id"))));

app.get("/api/trip", async (c) => c.json(await me(c.env).trip()));
app.post("/api/trip", async (c) => c.json(await me(c.env).startTrip(await c.req.json())));
app.delete("/api/trip", async (c) => {
  await me(c.env).cancelTrip();
  return c.json({ ok: true });
});
app.post("/api/trip/gps", async (c) => {
  const { lat, lng, acc } = await c.req.json<{ lat: number; lng: number; acc: number }>();
  await me(c.env).addGps(lat, lng, acc);
  return c.json({ ok: true });
});
app.get("/api/history", async (c) => c.json(await me(c.env).history()));
app.get("/api/history/:id", async (c) => c.json(await me(c.env).tripLog(c.req.param("id"))));

app.all("/api/*", (c) => c.json({ error: "not found" }, 404));
app.get("*", (c) => serveStatic(new URL(c.req.url).pathname) ?? c.text("not found", 404));

export default app;
