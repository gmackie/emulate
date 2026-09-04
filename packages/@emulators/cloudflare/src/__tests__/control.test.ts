import { describe, it, expect, afterEach } from "vitest";
import { createHarness, type Harness, type D1Envelope } from "./helpers.js";
import type { PrivilegedOutcome } from "../oracle.js";

const DB_ID = "11111111-1111-4111-8111-111111111111";

let harness: Harness | undefined;

function open(): Harness {
  harness = createHarness({ d1: { databases: [{ name: "app_dev", id: DB_ID }] } });
  return harness;
}

function plan(h: Harness, perturbations: unknown[], allowContractProbes = false): Promise<Response> {
  return h.request("/_cloudfault/plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ perturbations, allowContractProbes }),
  });
}

async function rowCount(h: Harness): Promise<number> {
  const body = (await (await h.query(DB_ID, "SELECT count(*) AS c FROM t")).json()) as D1Envelope;
  return (body.result[0].results as Array<{ c: number }>)[0].c;
}

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
});

describe("control plane and oracle", () => {
  it("records a clean write as committed, keyed by the caller-minted token", async () => {
    const h = open();
    await h.query(DB_ID, "CREATE TABLE t (id INTEGER PRIMARY KEY)");
    const response = await h.query(DB_ID, "INSERT INTO t (id) VALUES (1)", undefined, {
      "x-emulate-operation": "tok-clean",
    });
    expect(response.headers.get("x-emulate-operation")).toBe("tok-clean");

    const outcome = await h.json<PrivilegedOutcome>("/_cloudfault/outcome/tok-clean");
    expect(outcome.actual).toBe("committed");
    expect(outcome.observed).toBe("success");
    expect(outcome.version).toBe(2);
    expect(outcome.evidence?.changes).toBe(1);
    expect(outcome.applied).toEqual([{ index: 0, committed: true }]);
  });

  it("degrades an unknown token to 404 rather than guessing", async () => {
    const h = open();
    const response = await h.request("/_cloudfault/outcome/never-seen");
    expect(response.status).toBe(404);
  });

  it("destroys the response after committing, and the oracle still answers", async () => {
    const h = open();
    await h.query(DB_ID, "CREATE TABLE t (id INTEGER PRIMARY KEY)");

    const planned = await plan(h, [
      {
        id: "lost-1",
        target: "app_dev",
        kind: "commit-then-response-lost",
        phase: "after-commit-before-response",
        operation: "d1.query",
        actualOutcome: "committed",
        observedOutcome: "indeterminate",
      },
    ]);
    expect(planned.status).toBe(204);

    // The response body errors mid-flight; over a real socket the client sees a
    // reset. Reading it here throws, which is the point: there is no answer.
    const response = await h.query(DB_ID, "INSERT INTO t (id) VALUES (1)", undefined, {
      "x-emulate-operation": "tok-lost",
    });
    await expect(response.text()).rejects.toBeTruthy();

    // The write really landed.
    expect(await rowCount(h)).toBe(1);

    const outcome = await h.json<PrivilegedOutcome>("/_cloudfault/outcome/tok-lost");
    expect(outcome.actual).toBe("committed");
    expect(outcome.observed).toBe("indeterminate");
    expect(outcome.fault).toEqual({ id: "lost-1", kind: "commit-then-response-lost" });
  });

  it("reports a 5xx after commit as committed, not as a failure", async () => {
    const h = open();
    await h.query(DB_ID, "CREATE TABLE t (id INTEGER PRIMARY KEY)");
    await plan(h, [
      {
        id: "err-1",
        target: "*",
        kind: "error-after-commit",
        phase: "after-commit-before-response",
        operation: "d1.query",
      },
    ]);

    const response = await h.query(DB_ID, "INSERT INTO t (id) VALUES (1)", undefined, {
      "x-emulate-operation": "tok-err",
    });
    expect(response.status).toBe(500);
    const body = (await response.json()) as { success: boolean };
    expect(body.success).toBe(false);

    // The caller was told it failed. It did not.
    expect(await rowCount(h)).toBe(1);
    const outcome = await h.json<PrivilegedOutcome>("/_cloudfault/outcome/tok-err");
    expect(outcome.actual).toBe("committed");
    expect(outcome.observed).toBe("definite-failure");
  });

  it("reports a pre-commit rejection as not-committed", async () => {
    const h = open();
    await h.query(DB_ID, "CREATE TABLE t (id INTEGER PRIMARY KEY)");
    await plan(h, [
      {
        id: "rej-1",
        target: "*",
        kind: "reject-before-commit",
        phase: "before-commit",
        operation: "d1.query",
        metadata: { status: 503 },
      },
    ]);

    const response = await h.query(DB_ID, "INSERT INTO t (id) VALUES (1)", undefined, {
      "x-emulate-operation": "tok-rej",
    });
    expect(response.status).toBe(503);
    expect(await rowCount(h)).toBe(0);
    const outcome = await h.json<PrivilegedOutcome>("/_cloudfault/outcome/tok-rej");
    expect(outcome.actual).toBe("not-committed");
  });

  it("rate limits with a Retry-After", async () => {
    const h = open();
    await plan(h, [
      {
        id: "rl-1",
        target: "*",
        kind: "rate-limit",
        phase: "before-commit",
        operation: "d1.query",
        metadata: { retryAfterSeconds: 7 },
      },
    ]);
    const response = await h.query(DB_ID, "SELECT 1");
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("7");
  });

  it("honours selector.occurrence so only the nominated attempt is hit", async () => {
    const h = open();
    await h.query(DB_ID, "CREATE TABLE t (id INTEGER PRIMARY KEY)");
    await plan(h, [
      {
        id: "occ-1",
        target: "*",
        kind: "reject-before-commit",
        phase: "before-commit",
        operation: "d1.query",
        selector: { occurrence: 2 },
      },
    ]);
    // Posting a plan resets the occurrence counters, so the three queries
    // below are occurrences 1, 2 and 3.
    expect((await h.query(DB_ID, "INSERT INTO t (id) VALUES (1)")).status).toBe(200);
    expect((await h.query(DB_ID, "INSERT INTO t (id) VALUES (2)")).status).toBe(500);
    expect((await h.query(DB_ID, "INSERT INTO t (id) VALUES (3)")).status).toBe(200);
    expect(await rowCount(h)).toBe(2);
  });

  it("refuses a contract probe unless it is opted into explicitly", async () => {
    const h = open();
    const refused = await plan(h, [
      {
        id: "probe-1",
        target: "*",
        kind: "partial-batch-application",
        phase: "after-commit-before-response",
        operation: "d1.query",
      },
    ]);
    expect(refused.status).toBe(400);
    const body = (await refused.json()) as { error: string };
    expect(body.error).toContain("contract probe");

    const accepted = await plan(
      h,
      [
        {
          id: "probe-1",
          target: "*",
          kind: "partial-batch-application",
          phase: "after-commit-before-response",
          operation: "d1.query",
          metadata: { applyCount: 1 },
        },
      ],
      true,
    );
    expect(accepted.status).toBe(204);
  });

  it("applies only a prefix of the batch under the partial-batch contract probe", async () => {
    const h = open();
    await h.query(DB_ID, "CREATE TABLE t (id INTEGER PRIMARY KEY)");
    await plan(
      h,
      [
        {
          id: "probe-2",
          target: "*",
          kind: "partial-batch-application",
          phase: "after-commit-before-response",
          operation: "d1.query",
          metadata: { applyCount: 1 },
        },
      ],
      true,
    );

    const response = await h.query(
      DB_ID,
      "INSERT INTO t (id) VALUES (1);\nINSERT INTO t (id) VALUES (2);\nINSERT INTO t (id) VALUES (3);",
      undefined,
      { "x-emulate-operation": "tok-probe" },
    );
    expect(response.status).toBe(500);
    expect(await rowCount(h)).toBe(1);

    const outcome = await h.json<PrivilegedOutcome>("/_cloudfault/outcome/tok-probe");
    expect(outcome.actual).toBe("committed");
    expect(outcome.applied).toEqual([
      { index: 0, committed: true },
      { index: 1, committed: false, detail: "not reached (contract probe)" },
      { index: 2, committed: false, detail: "not reached (contract probe)" },
    ]);
  });

  it("logs activations and exposes resource versions", async () => {
    const h = open();
    await h.query(DB_ID, "CREATE TABLE t (id INTEGER PRIMARY KEY)");
    await plan(h, [{ id: "act-1", target: "*", kind: "rate-limit", phase: "before-commit", operation: "d1.query" }]);
    await h.query(DB_ID, "SELECT 1");

    const events = await h.json<{ activations: Array<{ perturbationId: string; occurrence: number }> }>(
      "/_cloudfault/events",
    );
    expect(events.activations.at(-1)?.perturbationId).toBe("act-1");

    const version = await h.json<{ resource: string; version: number | null }>(`/_cloudfault/version/d1:${DB_ID}`);
    expect(version.version).toBe(1);
  });

  it("clears the plan and the ledger on reset", async () => {
    const h = open();
    await h.query(DB_ID, "CREATE TABLE t (id INTEGER PRIMARY KEY)", undefined, {
      "x-emulate-operation": "tok-reset",
    });
    expect((await h.request("/_cloudfault/outcome/tok-reset")).status).toBe(200);

    const reset = await h.request("/_cloudfault/reset", { method: "POST" });
    expect(reset.status).toBe(204);
    expect((await h.request("/_cloudfault/outcome/tok-reset")).status).toBe(404);

    // The engine restarted, so the table is gone but the database still exists.
    const after = await h.query(DB_ID, "SELECT count(*) AS c FROM t");
    expect(after.status).toBe(400);
  });

  it("documents itself at /_cloudfault", async () => {
    const h = open();
    const body = await h.json<{ kinds: string[]; contractProbes: { kinds: string[] } }>("/_cloudfault");
    expect(body.kinds).toContain("commit-then-response-lost");
    expect(body.contractProbes.kinds).toContain("r2-list-after-put-stale");
  });
});
