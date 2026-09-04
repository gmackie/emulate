import { Store, type Collection } from "@emulators/core";
import type { D1DatabaseRow, R2BucketRow, OperationRow, ActivationRow } from "./entities.js";

export interface CloudflareStore {
  databases: Collection<D1DatabaseRow>;
  buckets: Collection<R2BucketRow>;
  operations: Collection<OperationRow>;
  activations: Collection<ActivationRow>;
}

/**
 * Only metadata lives here. The bytes live in Miniflare's own persistence
 * directories (`d1Persist` / `r2Persist`), outside emulate's snapshot model,
 * exactly as PGlite's `dataDir` is. Keeping ids, names and the oracle ledger in
 * the Store is what makes them snapshottable and visible in the inspector.
 */
export function getCloudflareStore(store: Store): CloudflareStore {
  return {
    databases: store.collection<D1DatabaseRow>("cloudflare.databases", ["uuid", "name", "binding"]),
    buckets: store.collection<R2BucketRow>("cloudflare.buckets", ["name", "binding"]),
    operations: store.collection<OperationRow>("cloudflare.operations", ["token", "resource"]),
    activations: store.collection<ActivationRow>("cloudflare.activations", ["token", "perturbation_id"]),
  };
}
