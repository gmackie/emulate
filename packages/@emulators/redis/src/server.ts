import { RedisMemoryServer } from "redis-memory-server";

let redisServer: RedisMemoryServer | null = null;

export interface RedisServerConfig {
  port?: number;
  binary?: {
    version?: string;
  };
}

export async function startRedisServer(config: RedisServerConfig): Promise<{
  host: string;
  port: number;
  stop: () => Promise<void>;
}> {
  if (redisServer) {
    throw new Error("Redis server already running. Call stopRedisServer() first.");
  }

  redisServer = new RedisMemoryServer({
    instance: {
      port: config.port ?? 6379,
    },
    binary: config.binary,
  });

  const host = await redisServer.getHost();
  const port = await redisServer.getPort();

  return {
    host,
    port,
    async stop() {
      if (redisServer) {
        await redisServer.stop();
        redisServer = null;
      }
    },
  };
}

export async function stopRedisServer(): Promise<void> {
  if (redisServer) {
    await redisServer.stop();
    redisServer = null;
  }
}

export function getRedisServer(): RedisMemoryServer | null {
  return redisServer;
}
