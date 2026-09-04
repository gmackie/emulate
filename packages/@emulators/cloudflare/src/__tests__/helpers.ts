import { createServer } from "@emulators/core";
import {
  cloudflarePlugin,
  seedFromConfig,
  stopCloudflareEngine,
  resetFaultPlan,
  type CloudflareSeedConfig,
} from "../index.js";

export const ACCOUNT_ID = "0000000000000000000000000000000000";

export interface Harness {
  app: ReturnType<typeof createServer>["app"];
  store: ReturnType<typeof createServer>["store"];
  request(path: string, init?: RequestInit): Promise<Response>;
  json<T>(path: string, init?: RequestInit): Promise<T>;
  query(databaseId: string, sql: string, params?: unknown[], headers?: Record<string, string>): Promise<Response>;
  dispose(): Promise<void>;
}

export function createHarness(config: CloudflareSeedConfig = {}): Harness {
  const server = createServer(cloudflarePlugin, { port: 4100, baseUrl: "http://localhost:4100" });
  cloudflarePlugin.seed?.(server.store, server.baseUrl);
  seedFromConfig(server.store, server.baseUrl, { account_id: ACCOUNT_ID, ...config });

  const request = (path: string, init?: RequestInit): Promise<Response> =>
    server.app.fetch(new Request(`http://localhost:4100${path}`, init));

  return {
    app: server.app,
    store: server.store,
    request,
    async json<T>(path: string, init?: RequestInit): Promise<T> {
      const response = await request(path, init);
      return (await response.json()) as T;
    },
    query(databaseId, sql, params, headers) {
      return request(`/client/v4/accounts/${ACCOUNT_ID}/d1/database/${databaseId}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(params ? { sql, params } : { sql }),
      });
    },
    async dispose() {
      await stopCloudflareEngine();
      // The fault plan is a module singleton, like the engine, so it has to be
      // cleared between harnesses.
      resetFaultPlan();
      server.store.reset();
    },
  };
}

export interface D1Envelope {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result: Array<{
    success: boolean;
    results: unknown;
    meta: Record<string, unknown>;
  }>;
}
