import { describe, it, expect, afterAll } from "vitest";
import { createEmulator, type Emulator } from "../api.js";

describe("redis emulator", { timeout: 60_000 }, () => {
  let redis: Emulator;

  afterAll(async () => {
    if (redis) {
      const { stopRedisServer } = await import("@emulators/redis");
      await stopRedisServer();
      await redis.close();
    }
  });

  it("starts and serves HTTP status endpoint", async () => {
    redis = await createEmulator({
      service: "redis",
      port: 14200,
      seed: {
        redis: {
          port: 16379,
        },
      },
    });

    expect(redis.url).toBe("http://localhost:14200");

    const res = await fetch(`${redis.url}/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: string };
    expect(body.version).toContain("redis-memory-server");
  });
});
