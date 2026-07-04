import type { Hono } from "hono";
import type { ServicePlugin, Store, WebhookDispatcher, TokenMap, AppEnv, RouteContext } from "@emulators/core";
import { getPostgresStore } from "./store.js";
import { startPostgresServer, stopPostgresServer } from "./server.js";
import { adminRoutes } from "./routes/admin.js";
import { inspectorRoutes } from "./routes/inspector.js";

export { getPostgresStore, type PostgresStore } from "./store.js";
export * from "./entities.js";
export { startPostgresServer, stopPostgresServer, getPgliteInstance } from "./server.js";

export interface PostgresSeedConfig {
  port?: number;
  data_dir?: string;
  databases?: Array<{
    name: string;
    extensions?: string[];
  }>;
}

function seedDefaults(store: Store, _baseUrl: string): void {
  const ps = getPostgresStore(store);
  ps.databases.insert({
    name: "postgres",
    extensions: [],
  });
}

export function seedFromConfig(store: Store, _baseUrl: string, config: PostgresSeedConfig): void {
  const ps = getPostgresStore(store);

  if (config.databases) {
    for (const db of config.databases) {
      const existing = ps.databases.all().find((d) => d.name === db.name);
      if (!existing) {
        ps.databases.insert({
          name: db.name,
          extensions: db.extensions ?? [],
        });
      }
    }
  }

  // Start the PGlite TCP server
  const port = config.port ?? 5432;
  const dataDir = config.data_dir ?? "./data/pglite";

  startPostgresServer({
    port,
    dataDir,
    databases: config.databases,
  })
    .then(() => {
      console.log(`  postgres wire protocol listening on localhost:${port}`);
    })
    .catch((err) => {
      console.error("[postgres] Failed to start PGlite server:", err);
    });
}

export const postgresPlugin: ServicePlugin = {
  name: "postgres",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    inspectorRoutes(ctx);
    adminRoutes(ctx);
  },
  seed(store: Store, baseUrl: string): void {
    seedDefaults(store, baseUrl);
  },
};

export default postgresPlugin;
