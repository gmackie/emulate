import { type Store, type Collection } from "@emulators/core";
import type { PostgresDatabase } from "./entities.js";

export interface PostgresStore {
  databases: Collection<PostgresDatabase>;
}

export function getPostgresStore(store: Store): PostgresStore {
  return {
    databases: store.collection<PostgresDatabase>("postgres.databases", ["name"]),
  };
}
