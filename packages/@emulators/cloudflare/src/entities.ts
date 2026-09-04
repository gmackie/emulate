import type { Entity } from "@emulators/core";

/** "committed" | "not-committed" | "unknown", mirroring CloudFault's ActualOutcome. */
export type ActualOutcome = "committed" | "not-committed" | "unknown";

/** Mirrors CloudFault's ObservedOutcome. */
export type ObservedOutcome = "success" | "definite-failure" | "indeterminate";

export interface AppliedSubOperation {
  index: number;
  committed: boolean;
  detail?: string;
}

export interface D1DatabaseRow extends Entity {
  uuid: string;
  name: string;
  /** The Miniflare binding this database is reachable through. */
  binding: string;
  version: string;
  file_size: number;
  num_tables: number;
  jurisdiction: string;
  read_replication_mode: "auto" | "disabled";
  running_in_region: string;
}

export interface R2BucketRow extends Entity {
  name: string;
  /** The Miniflare binding this bucket is reachable through. */
  binding: string;
  location: string;
  storage_class: string;
  jurisdiction: string;
  s3_access_key_id: string;
  s3_secret_access_key: string;
}

/**
 * One row per attempted operation, keyed by the token the caller minted (or
 * the emulator minted for it). This is the oracle's ledger: it survives the
 * response being destroyed, which is the entire reason it exists.
 */
export interface OperationRow extends Entity {
  token: string;
  service: "d1" | "r2";
  operation: string;
  resource: string;
  method: string;
  path: string;
  started_at: string;
  finished_at: string | null;
  actual: ActualOutcome;
  observed: ObservedOutcome | null;
  version: number | null;
  applied: AppliedSubOperation[] | null;
  evidence: Record<string, unknown> | null;
  fault_id: string | null;
  fault_kind: string | null;
}

/** One row per fault activation, mirroring a CloudFault history "fault" event. */
export interface ActivationRow extends Entity {
  token: string;
  perturbation_id: string;
  kind: string;
  phase: string;
  target: string;
  operation: string;
  resource: string;
  occurrence: number;
  execution_index: number;
  at: string;
}
