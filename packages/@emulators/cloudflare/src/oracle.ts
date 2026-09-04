import type { Store } from "@emulators/core";
import { getCloudflareStore } from "./store.js";
import type { ActualOutcome, ObservedOutcome, AppliedSubOperation, OperationRow } from "./entities.js";

/**
 * The oracle: what actually happened, asked for by a token the CALLER minted.
 *
 * The reason it is caller-minted rather than response-minted is the fault that
 * matters most. Under `commit-then-response-lost` there is no response to read
 * a correlation header off, so a token derived from the response cannot answer
 * the only question worth asking. A caller that mints the token before sending
 * can always come back and ask about an attempt whose response it destroyed.
 *
 * Honesty constraint: `outcomeFor()` returning undefined must degrade to
 * "unknown", never to "committed". The emulator never guesses; it records what
 * the engine did, after the engine did it.
 */

export type OperationToken = string;

export interface PrivilegedOutcome {
  /** The provider's own answer. Never inferred from an HTTP status. */
  actual: ActualOutcome;
  /** What the caller was allowed to observe, when the emulator chose it. */
  observed?: ObservedOutcome;
  /** Provider-side commit ordering, for consistency checkers. */
  version?: number;
  /** For batch/multi-statement operations: which sub-operations durably applied. */
  applied?: readonly AppliedSubOperation[];
  /** Free-form provider evidence (rows_written, etag, changes, ...). */
  evidence?: Record<string, unknown>;
  /** The fault that was activated on this attempt, if any. */
  fault?: { id: string; kind: string } | null;
  operation?: string;
  resource?: string;
  startedAt?: string;
  finishedAt?: string | null;
}

export interface BeginInput {
  token: OperationToken;
  service: "d1" | "r2";
  operation: string;
  resource: string;
  method: string;
  path: string;
}

export interface RecordInput {
  actual: ActualOutcome;
  observed?: ObservedOutcome;
  version?: number;
  applied?: AppliedSubOperation[];
  evidence?: Record<string, unknown>;
  fault?: { id: string; kind: string } | null;
}

const VERSIONS_KEY = "cloudflare.versions";

export class Oracle {
  constructor(private readonly store: Store) {}

  #versions(): Map<string, number> {
    let versions = this.store.getData<Map<string, number>>(VERSIONS_KEY);
    if (!versions) {
      versions = new Map();
      this.store.setData(VERSIONS_KEY, versions);
    }
    return versions;
  }

  begin(input: BeginInput): OperationRow {
    const collection = getCloudflareStore(this.store).operations;
    const existing = collection.findOneBy("token", input.token);
    if (existing) {
      // A retried attempt reuses the token on purpose; the ledger keeps the
      // first row and appends nothing, so `outcomeFor` stays a function of the
      // token rather than of arrival order.
      return existing;
    }
    return collection.insert({
      token: input.token,
      service: input.service,
      operation: input.operation,
      resource: input.resource,
      method: input.method,
      path: input.path,
      started_at: new Date().toISOString(),
      finished_at: null,
      actual: "unknown",
      observed: null,
      version: null,
      applied: null,
      evidence: null,
      fault_id: null,
      fault_kind: null,
    });
  }

  record(token: OperationToken, input: RecordInput): void {
    const collection = getCloudflareStore(this.store).operations;
    const row = collection.findOneBy("token", token);
    if (!row) return;
    collection.update(row.id, {
      finished_at: new Date().toISOString(),
      actual: input.actual,
      observed: input.observed ?? null,
      version: input.version ?? row.version,
      applied: input.applied ?? row.applied,
      evidence: input.evidence ?? row.evidence,
      fault_id: input.fault?.id ?? row.fault_id,
      fault_kind: input.fault?.kind ?? row.fault_kind,
    });
  }

  outcomeFor(token: OperationToken): PrivilegedOutcome | undefined {
    const row = getCloudflareStore(this.store).operations.findOneBy("token", token);
    if (!row) return undefined;
    return {
      actual: row.actual,
      observed: row.observed ?? undefined,
      version: row.version ?? undefined,
      applied: row.applied ?? undefined,
      evidence: row.evidence ?? undefined,
      fault: row.fault_id ? { id: row.fault_id, kind: row.fault_kind ?? "unknown" } : null,
      operation: row.operation,
      resource: row.resource,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    };
  }

  /** Monotonic commit counter for a logical resource ("d1:<uuid>", "r2:<bucket>"). */
  bumpVersion(resource: string): number {
    const versions = this.#versions();
    const next = (versions.get(resource) ?? 0) + 1;
    versions.set(resource, next);
    return next;
  }

  versionOf(resource: string): number | undefined {
    return this.#versions().get(resource);
  }

  snapshot(): {
    databases: unknown[];
    buckets: unknown[];
    operations: unknown[];
    versions: Record<string, number>;
  } {
    const cf = getCloudflareStore(this.store);
    return {
      databases: cf.databases.all(),
      buckets: cf.buckets.all(),
      operations: cf.operations.all(),
      versions: Object.fromEntries(this.#versions()),
    };
  }

  reset(): void {
    const cf = getCloudflareStore(this.store);
    cf.operations.clear();
    cf.activations.clear();
    this.store.setData(VERSIONS_KEY, new Map<string, number>());
  }
}

/** The header the token travels on, in both directions. Analogous to `cf-ray`. */
export const OPERATION_TOKEN_HEADER = "x-emulate-operation";

export function mintToken(): OperationToken {
  return `op_${crypto.randomUUID().replace(/-/g, "")}`;
}
