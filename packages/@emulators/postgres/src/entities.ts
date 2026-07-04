import type { Entity } from "@emulators/core";

export interface PostgresDatabase extends Entity {
  name: string;
  extensions: string[];
}
