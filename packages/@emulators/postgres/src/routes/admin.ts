import type { RouteContext } from "@emulators/core";
import { getPostgresStore } from "../store.js";
import { getPgliteInstance } from "../server.js";

export function adminRoutes(ctx: RouteContext): void {
  const { app } = ctx;

  app.get("/status", async (c) => {
    const pglite = getPgliteInstance();
    const ps = getPostgresStore(ctx.store);
    const databases = ps.databases.all();

    return c.json({
      running: pglite !== null,
      version: "17.4 (PGlite/WASM)",
      databases: databases.map((d) => d.name),
      database_count: databases.length,
    });
  });

  app.post("/reset", async (c) => {
    const pglite = getPgliteInstance();
    if (!pglite) {
      return c.json({ error: "Postgres is not running" }, 503);
    }

    await pglite.exec(`
      DO $$ DECLARE
        r RECORD;
      BEGIN
        FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
          EXECUTE 'DROP TABLE IF EXISTS public.' || quote_ident(r.tablename) || ' CASCADE';
        END LOOP;
      END $$;
    `);

    return c.json({ reset: true });
  });

  app.get("/databases", async (c) => {
    const ps = getPostgresStore(ctx.store);
    return c.json({ databases: ps.databases.all() });
  });
}
