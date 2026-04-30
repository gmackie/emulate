import type { Entity } from "@emulators/core";

export interface RedisInstance extends Entity {
  port: number;
  host: string;
  running: boolean;
}


