import { Hono } from "hono";
import type { Env } from "./env";
import { probe } from "./probe";

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    secrets: {
      DATA_GO_KR_API_KEY: Boolean(c.env.DATA_GO_KR_API_KEY),
      SEOUL_BUS_API_KEY: Boolean(c.env.SEOUL_BUS_API_KEY),
    },
  }),
);

app.get("/api/probe", async (c) => c.json(await probe(c.env)));

export default app;
