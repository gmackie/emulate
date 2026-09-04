import type { ActualOutcome, ObservedOutcome } from "./entities.js";

/**
 * The fault surface, expressed in CloudFault's own vocabulary so a
 * `Perturbation[]` can be posted to `/_cloudfault/plan` verbatim.
 *
 * Nothing here is CloudFault-specific at runtime: the emulator owns the plan,
 * the occurrence counting and the activation log, and CloudFault (or anything
 * else) drives it over HTTP.
 */

export type FaultPhase =
  | "before-send"
  | "before-commit"
  | "after-commit-before-response"
  | "during-response"
  | "after-response"
  | "delivery";

export interface PerturbationSelector {
  target?: string;
  operation?: string;
  resource?: string;
  process?: string | number;
  callsite?: string;
  executionIndex?: number;
  occurrence?: number;
}

export interface Perturbation {
  id: string;
  target: string;
  kind: FaultKind | string;
  /** A Fault has a phase; a SemanticVariation (legal behavior) does not. */
  phase?: FaultPhase;
  description?: string;
  operation?: string;
  category?: string;
  selector?: PerturbationSelector;
  actualOutcome?: ActualOutcome;
  observedOutcome?: ObservedOutcome;
  /** Defaults to 1, mirroring CloudFault's ScenarioController. */
  maxActivations?: number;
  metadata?: Record<string, unknown>;
}

export const FAULT_KINDS = [
  /** Apply the write in full, then destroy the response. actual=committed, observed=indeterminate. */
  "commit-then-response-lost",
  /** Alias CloudFault's adapter-sdk already emits for the same thing. */
  "commit-then-timeout",
  "commit-then-disconnect",
  /** Never reach the engine. actual=not-committed. */
  "timeout-before-send",
  /** Refuse before touching the engine. actual=not-committed. */
  "reject-before-commit",
  /** Apply the write, then answer 5xx. The app is TOLD it failed and it did not. */
  "error-after-commit",
  /** 429 with Retry-After. */
  "rate-limit",
  /** Truncate the envelope mid-result. Only the oracle can say what happened. */
  "malformed-response",
  /** Delay before dispatching. */
  "latency",
  /** Reject SigV4 on the R2 S3 front door. */
  "signature-rejected",
  /** Fail an R2 conditional (If-Match / onlyIf) even though the etag matches. */
  "r2-conditional-race",
  /** CONTRACT PROBE: apply a prefix of a batch then fail. Real D1 batches are atomic. */
  "partial-batch-application",
  /** CONTRACT PROBE: apply a prefix of a multi-statement migration then fail. */
  "migration-partial-then-fail",
  /** CONTRACT PROBE: hide recent puts from list. Real R2 list is strongly consistent. */
  "r2-list-after-put-stale",
] as const;

export type FaultKind = (typeof FAULT_KINDS)[number];

/**
 * Kinds that do NOT model anything Cloudflare does.
 *
 * Real D1 batches are atomic and real R2 list is strongly consistent, so these
 * discover undocumented reliance on a guarantee rather than reproducing a
 * provider behavior. They are refused unless the plan opts in explicitly, so
 * nobody can accidentally present them as fidelity.
 */
export const CONTRACT_PROBE_KINDS: ReadonlySet<string> = new Set([
  "partial-batch-application",
  "migration-partial-then-fail",
  "r2-list-after-put-stale",
]);

export interface OperationRef {
  target: string;
  operation: string;
  resource: string;
  process?: string | number;
  callsite?: string;
}

export interface Activation {
  perturbationId: string;
  kind: string;
  phase: FaultPhase;
  target: string;
  operation: string;
  resource: string;
  occurrence: number;
  executionIndex: number;
  token: string;
  at: string;
}

export class PlanRejectedError extends Error {}

interface PlanEntry {
  perturbation: Perturbation;
  activations: number;
}

/**
 * Mirrors CloudFault's ScenarioController: `begin` assigns an execution index
 * and a context-relative occurrence, `eligible` filters by selector, phase and
 * remaining activations, `take` does both.
 */
export class FaultPlan {
  #entries: PlanEntry[] = [];
  #activations: Activation[] = [];
  #executionIndex = 0;
  #occurrences = new Map<string, number>();

  set(perturbations: Perturbation[], options: { allowContractProbes?: boolean } = {}): void {
    for (const perturbation of perturbations) {
      if (CONTRACT_PROBE_KINDS.has(perturbation.kind) && !options.allowContractProbes) {
        throw new PlanRejectedError(
          `"${perturbation.kind}" is a contract probe, not a fidelity claim: real D1 batches are atomic and real R2 list is strongly consistent. Post the plan with {"allowContractProbes": true} to enable it.`,
        );
      }
    }
    this.#entries = perturbations.map((perturbation) => ({ perturbation, activations: 0 }));
    this.#occurrences.clear();
  }

  clear(): void {
    this.#entries = [];
    this.#occurrences.clear();
  }

  reset(): void {
    this.clear();
    this.#activations = [];
    this.#executionIndex = 0;
  }

  get perturbations(): readonly Perturbation[] {
    return this.#entries.map((entry) => entry.perturbation);
  }

  get activations(): readonly Activation[] {
    return this.#activations;
  }

  /** Assign this attempt an execution index and a per-(target,operation) occurrence. */
  begin(op: OperationRef): { executionIndex: number; occurrence: number } {
    const executionIndex = this.#executionIndex++;
    const key = `${op.target}|${op.operation}`;
    const occurrence = (this.#occurrences.get(key) ?? 0) + 1;
    this.#occurrences.set(key, occurrence);
    return { executionIndex, occurrence };
  }

  #matches(perturbation: Perturbation, op: OperationRef, ctx: { executionIndex: number; occurrence: number }): boolean {
    const selector = perturbation.selector;
    if (perturbation.target && perturbation.target !== "*" && perturbation.target !== op.target) return false;
    if (perturbation.operation && perturbation.operation !== op.operation) return false;
    if (!selector) return true;
    if (selector.target !== undefined && selector.target !== op.target) return false;
    if (selector.operation !== undefined && selector.operation !== op.operation) return false;
    if (selector.resource !== undefined && selector.resource !== op.resource) return false;
    if (selector.process !== undefined && selector.process !== op.process) return false;
    if (selector.callsite !== undefined && selector.callsite !== op.callsite) return false;
    if (selector.executionIndex !== undefined && selector.executionIndex !== ctx.executionIndex) return false;
    if (selector.occurrence !== undefined && selector.occurrence !== ctx.occurrence) return false;
    return true;
  }

  take(
    op: OperationRef,
    phase: FaultPhase,
    ctx: { executionIndex: number; occurrence: number; token: string },
  ): Perturbation | undefined {
    for (const entry of this.#entries) {
      const { perturbation } = entry;
      if (perturbation.phase !== phase) continue;
      if (entry.activations >= (perturbation.maxActivations ?? 1)) continue;
      if (!this.#matches(perturbation, op, ctx)) continue;
      entry.activations++;
      this.#activations.push({
        perturbationId: perturbation.id,
        kind: perturbation.kind,
        phase,
        target: op.target,
        operation: op.operation,
        resource: op.resource,
        occurrence: ctx.occurrence,
        executionIndex: ctx.executionIndex,
        token: ctx.token,
        at: new Date().toISOString(),
      });
      return perturbation;
    }
    return undefined;
  }
}

let plan = new FaultPlan();

export function getFaultPlan(): FaultPlan {
  return plan;
}

export function resetFaultPlan(): void {
  plan = new FaultPlan();
}

export function metaNumber(perturbation: Perturbation | undefined, key: string, fallback: number): number {
  const value = perturbation?.metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
