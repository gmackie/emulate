import type { Context } from "@emulators/core";
import { cfFail, type CloudflareEnvelope } from "./envelope.js";
import { getFaultPlan, metaNumber, type OperationRef, type Perturbation } from "./faults.js";
import { Oracle, OPERATION_TOKEN_HEADER, mintToken } from "./oracle.js";

/**
 * The one prefix every REST route is registered under.
 *
 * api.cloudflare.com serves the REST API only at `/client/v4/...`, and
 * `CLOUDFLARE_API_BASE_URL` is expected to include it. The emulator used to
 * register the bare `/accounts/...` form as well, out of politeness. That was a
 * fidelity bug of exactly the class this emulator exists to catch: a base URL
 * missing `/client/v4` passed locally and 404d in production, and it quietly
 * weakened any test that asserted the unprefixed path fails. Unknown paths are
 * answered by `apiNotFoundRoutes` instead, the way the real API answers them.
 */
export const API_PREFIX = "/client/v4";

export function jsonEnvelope<T>(c: Context, envelope: CloudflareEnvelope<T>, status = 200): Response {
  return c.json(envelope, status);
}

export function failEnvelope(c: Context, code: number, message: string, status = 400): Response {
  return c.json(cfFail(code, message), status);
}

/** Read the caller-minted token, or mint one and echo it. */
export function resolveToken(c: Context): string {
  const supplied = c.req.header(OPERATION_TOKEN_HEADER);
  return supplied && supplied.trim().length > 0 ? supplied.trim() : mintToken();
}

export interface AttemptPlan {
  token: string;
  op: OperationRef;
  executionIndex: number;
  occurrence: number;
  /** Fault to apply before the engine is touched, if any. */
  pre?: Perturbation;
  /** Fault to apply to the response after the engine has run, if any. */
  post?: Perturbation;
}

/**
 * Consult the plan for one attempt.
 *
 * The post-commit fault is taken BEFORE the engine runs even though it applies
 * afterwards, because some of them (partial batch application) change what the
 * engine is asked to do. The emulator is on the inside; it does not have to
 * discover its own faults after the fact.
 */
export function beginAttempt(c: Context, op: OperationRef, oracle: Oracle, service: "d1" | "r2"): AttemptPlan {
  const token = resolveToken(c);
  const plan = getFaultPlan();
  const { executionIndex, occurrence } = plan.begin(op);
  oracle.begin({
    token,
    service,
    operation: op.operation,
    resource: op.resource,
    method: c.req.method,
    path: c.req.path,
  });
  const ctx = { executionIndex, occurrence, token };
  const pre = plan.take(op, "before-send", ctx) ?? plan.take(op, "before-commit", ctx);
  const post = pre
    ? undefined
    : (plan.take(op, "after-commit-before-response", ctx) ?? plan.take(op, "during-response", ctx));
  c.header(OPERATION_TOKEN_HEADER, token);
  return { token, op, executionIndex, occurrence, pre, post };
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A response whose body errors before a single byte is written.
 *
 * `writeFetchResponse` reacts by calling `res.destroy()`, so the client sees a
 * reset socket rather than a status code. That is what makes
 * `commit-then-response-lost` genuinely indeterminate: there is no answer to
 * read, only the oracle.
 */
export function destroyedResponse(): Response {
  const body = new ReadableStream({
    start(controller) {
      controller.error(new Error("emulate: response destroyed after commit"));
    },
  });
  return new Response(body, { status: 200 });
}

/** A response that writes a prefix of the JSON envelope and then dies. */
export function truncatedResponse(payload: unknown, keepRatio = 0.6): Response {
  const full = new TextEncoder().encode(JSON.stringify(payload));
  const keep = full.slice(0, Math.max(1, Math.floor(full.length * keepRatio)));
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(keep);
      controller.error(new Error("emulate: response truncated mid-envelope"));
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "application/json; charset=UTF-8" } });
}

export interface PreFaultOutcome {
  response: Response;
  actual: "not-committed" | "unknown";
}

/**
 * Apply a fault that fires before the engine is touched. Nothing was written,
 * so the oracle's answer is always "not-committed" (or "unknown" for latency,
 * which does not itself decide anything).
 */
export async function applyPreFault(
  c: Context,
  perturbation: Perturbation,
): Promise<PreFaultOutcome | { latencyMs: number }> {
  switch (perturbation.kind) {
    case "latency": {
      const delayMs = metaNumber(perturbation, "delayMs", 250);
      await sleep(delayMs);
      return { latencyMs: delayMs };
    }
    case "timeout-before-send": {
      await sleep(metaNumber(perturbation, "hangMs", 1_000));
      return { response: destroyedResponse(), actual: "not-committed" };
    }
    case "rate-limit": {
      const retryAfter = metaNumber(perturbation, "retryAfterSeconds", 1);
      c.header("Retry-After", String(retryAfter));
      c.header("Ratelimit-Policy", '1200;w=300;comment="cloudflare api"');
      return {
        response: failEnvelope(c, 971, "You are being rate limited. Please retry later.", 429),
        actual: "not-committed",
      };
    }
    case "signature-rejected":
      return {
        response: c.text(
          '<?xml version="1.0" encoding="UTF-8"?><Error><Code>SignatureDoesNotMatch</Code><Message>The request signature we calculated does not match the signature you provided.</Message></Error>',
          403,
          { "Content-Type": "application/xml" },
        ),
        actual: "not-committed",
      };
    case "reject-before-commit":
    default: {
      const status = metaNumber(perturbation, "status", 500);
      const code = metaNumber(perturbation, "code", 7500);
      const message =
        typeof perturbation.metadata?.message === "string"
          ? perturbation.metadata.message
          : "Internal error. Please retry.";
      return { response: failEnvelope(c, code, message, status), actual: "not-committed" };
    }
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readJsonBody(c: Context): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await c.req.json();
    return isRecord(body) ? body : {};
  } catch {
    return {};
  }
}
