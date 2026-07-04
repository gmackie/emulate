import type { ServiceName } from "../registry.js";

const WIRE_PROTOCOL_SERVICES: ReadonlySet<ServiceName> = new Set(["postgres", "redis"]);

export function resolveHttpPort(
  svc: ServiceName,
  svcSeedConfig: Record<string, unknown> | undefined,
  basePort: number,
  index: number,
): number {
  // postgres/redis use `port` in their seed config to mean the WIRE PROTOCOL
  // port -- a separate raw socket server they start themselves inside
  // seedFromConfig (PGLiteSocketServer / a redis server) -- NOT the port for
  // the generic Hono HTTP admin/inspector app. Reusing the same value for
  // both made them race for the same port: whichever bound second failed
  // with EADDRINUSE, either crashing the CLI or leaving the wire protocol
  // silently unreachable behind an HTTP server.
  if (WIRE_PROTOCOL_SERVICES.has(svc)) {
    return basePort + index;
  }
  return (svcSeedConfig?.port as number | undefined) ?? basePort + index;
}
