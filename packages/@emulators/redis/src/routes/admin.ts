import type { RouteContext } from "@emulators/core";
import { getRedisStore } from "../store.js";
import { getRedisServer } from "../server.js";

export function adminRoutes(ctx: RouteContext): void {
  const { app } = ctx;

  app.get("/status", async (c) => {
    const server = getRedisServer();
    const rs = getRedisStore(ctx.store);
    const instances = rs.instances.all();
    const instance = instances[0];

    return c.json({
      running: server !== null,
      port: instance?.port ?? null,
      host: instance?.host ?? "127.0.0.1",
      version: "7.x (redis-memory-server)",
    });
  });

  app.post("/reset", async (c) => {
    const server = getRedisServer();
    if (!server) {
      return c.json({ error: "Redis is not running" }, 503);
    }

    return c.json({ error: "Not implemented. Use a Redis client: redis-cli FLUSHALL" }, 501);
  });

  app.post("/flush", async (c) => {
    const server = getRedisServer();
    if (!server) {
      return c.json({ error: "Redis is not running" }, 503);
    }

    return c.json({ error: "Not implemented. Use a Redis client: redis-cli FLUSHALL" }, 501);
  });
}
