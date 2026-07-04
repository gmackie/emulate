import { describe, it, expect } from "vitest";
import { resolveHttpPort } from "../commands/ports.js";

describe("resolveHttpPort", () => {
  it("uses the seed port as the HTTP port for regular services", () => {
    expect(resolveHttpPort("github", { port: 9100 }, 4000, 0)).toBe(9100);
  });

  it("falls back to basePort + index for regular services", () => {
    expect(resolveHttpPort("github", undefined, 4000, 2)).toBe(4002);
  });

  it("never binds the admin HTTP app to the wire port for redis", () => {
    // seed port 6379 belongs to redis-memory-server, not the hono app
    expect(resolveHttpPort("redis", { port: 6379 }, 4000, 6)).toBe(4006);
  });

  it("never binds the admin HTTP app to the wire port for postgres", () => {
    expect(resolveHttpPort("postgres", { port: 5432 }, 4000, 5)).toBe(4005);
  });
});
