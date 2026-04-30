import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createEmulator, type Emulator } from "../api.js";

describe("postgres emulator", { timeout: 30_000 }, () => {
  let pg: Emulator;
  let dataDir: string;

  afterAll(async () => {
    if (pg) {
      const { stopPostgresServer } = await import("@emulators/postgres");
      await stopPostgresServer();
      await pg.close();
    }
    if (dataDir) {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("starts and serves HTTP status endpoint", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "emulate-pg-test-"));
    pg = await createEmulator({
      service: "postgres",
      port: 14100,
      seed: {
        postgres: {
          port: 15432,
          data_dir: dataDir,
          databases: [{ name: "test_db" }],
        },
      },
    });

    expect(pg.url).toBe("http://localhost:14100");

    const res = await fetch(`${pg.url}/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { databases: string[]; database_count: number };
    expect(body.databases).toContain("postgres");
    expect(body.database_count).toBeGreaterThanOrEqual(1);
  });

  it("lists databases", async () => {
    const res = await fetch(`${pg.url}/databases`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { databases: Array<{ name: string }> };
    expect(body.databases.some((d) => d.name === "postgres")).toBe(true);
  });

  it("starts PGlite wire protocol server", async () => {
    for (let i = 0; i < 50; i++) {
      const res = await fetch(`${pg.url}/status`);
      const body = (await res.json()) as { running: boolean };
      if (body.running) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    const res = await fetch(`${pg.url}/status`);
    const body = (await res.json()) as { running: boolean };
    expect(body.running).toBe(true);
  });
});
