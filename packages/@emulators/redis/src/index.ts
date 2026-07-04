import type { Hono } from "hono";
import type { ServicePlugin, Store, WebhookDispatcher, TokenMap, AppEnv, RouteContext } from "@emulators/core";
import { getRedisStore } from "./store.js";
import { startRedisServer, stopRedisServer } from "./server.js";
import { adminRoutes } from "./routes/admin.js";
import { inspectorRoutes } from "./routes/inspector.js";

export { getRedisStore, type RedisStore } from "./store.js";
export * from "./entities.js";
export { startRedisServer, stopRedisServer, getRedisServer } from "./server.js";

export interface RedisSeedConfig {
  port?: number;
  binary?: {
    version?: string;
  };
}

export function seedFromConfig(store: Store, _baseUrl: string, config: RedisSeedConfig): void {
  const rs = getRedisStore(store);
  const port = config.port ?? 6379;

  startRedisServer({
    port,
    binary: config.binary,
  })
    .then((handle) => {
      rs.instances.insert({
        port: handle.port,
        host: handle.host,
        running: true,
      });

      console.log(`  redis wire protocol listening on ${handle.host}:${handle.port}`);
    })
    .catch((err) => {
      console.error("[redis] Failed to start Redis server:", err);
    });
}

export const redisPlugin: ServicePlugin = {
  name: "redis",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    inspectorRoutes(ctx);
    adminRoutes(ctx);
  },
};

export default redisPlugin;
