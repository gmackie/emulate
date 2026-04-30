import type { PGlite } from "@electric-sql/pglite";

let pgliteInstance: PGlite | null = null;
let socketServer: { stop(): Promise<void>; start(): Promise<void> } | null = null;

export interface PostgresServerConfig {
  port: number;
  dataDir: string;
  databases?: Array<{ name: string; extensions?: string[] }>;
}

export async function startPostgresServer(config: PostgresServerConfig): Promise<{
  pglite: PGlite;
  port: number;
  stop: () => Promise<void>;
}> {
  if (pgliteInstance) {
    throw new Error("PGlite server already running. Call stopPostgresServer() first.");
  }

  const { PGlite: PGliteClass } = await import("@electric-sql/pglite");
  const { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");

  pgliteInstance = await PGliteClass.create(config.dataDir);

  if (config.databases) {
    for (const db of config.databases) {
      if (db.extensions) {
        for (const ext of db.extensions) {
          try {
            if (!/^[a-z_][a-z0-9_]*$/i.test(ext)) {
              console.warn(`[postgres] Skipping invalid extension name: ${ext}`);
              continue;
            }
            await pgliteInstance.exec(`CREATE EXTENSION IF NOT EXISTS "${ext}"`);
          } catch (e) {
            console.warn(`[postgres] Failed to create extension ${ext}:`, e);
          }
        }
      }
    }
  }

  socketServer = new PGLiteSocketServer({
    db: pgliteInstance,
    port: config.port,
    host: "127.0.0.1",
  });
  await socketServer.start();

  return {
    pglite: pgliteInstance,
    port: config.port,
    stop: stopPostgresServer,
  };
}

export async function stopPostgresServer(): Promise<void> {
  if (socketServer) {
    await socketServer.stop();
    socketServer = null;
  }
  if (pgliteInstance) {
    await pgliteInstance.close();
    pgliteInstance = null;
  }
}

export function getPgliteInstance(): PGlite | null {
  return pgliteInstance;
}
