import { type Store, type Collection } from "@emulators/core";
import type { RedisInstance } from "./entities.js";

export interface RedisStore {
  instances: Collection<RedisInstance>;
}

export function getRedisStore(store: Store): RedisStore {
  return {
    instances: store.collection<RedisInstance>("redis.instances", ["port"]),
  };
}
