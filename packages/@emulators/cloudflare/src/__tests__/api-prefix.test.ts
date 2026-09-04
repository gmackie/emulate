import { describe, it, expect, afterEach } from "vitest";
import { createHarness, ACCOUNT_ID, type Harness } from "./helpers.js";
import { S3_ENDPOINT_PATH } from "../index.js";

/**
 * The REST API is served only under `/client/v4`, exactly like
 * api.cloudflare.com. Serving the bare `/accounts/...` form too was a fidelity
 * bug: a `CLOUDFLARE_API_BASE_URL` missing the prefix passed here and 404d in
 * production, which is precisely the failure this emulator exists to catch.
 *
 * The unprefixed answers below were measured against the live API.
 */

const DB_ID = "22222222-2222-4222-8222-222222222222";

interface FailEnvelope {
  success: boolean;
  result: null;
  messages: unknown[];
  errors: Array<{ code: number; message: string; documentation_url?: string }>;
}

let harness: Harness | undefined;

function open(): Harness {
  harness = createHarness({
    d1: { databases: [{ name: "app_dev", id: DB_ID }] },
    r2: { buckets: [{ name: "app-uploads", s3_access_key_id: "AKIAEMULATE", s3_secret_access_key: "emulate-secret" }] },
  });
  return harness;
}

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
});

async function expectCloudflare404(response: Response): Promise<FailEnvelope> {
  expect(response.status).toBe(404);
  expect(response.headers.get("Content-Type")).toContain("application/json");
  const body = (await response.json()) as FailEnvelope;
  // The envelope clients key off: never mistakable for a success.
  expect(body.success).toBe(false);
  expect(body.result).toBeNull();
  expect(body.messages).toEqual([]);
  expect(body.errors.length).toBeGreaterThan(0);
  return body;
}

describe("the /client/v4 prefix", () => {
  it("serves the REST API under the prefix", async () => {
    const h = open();
    const d1 = await h.request(`/client/v4/accounts/${ACCOUNT_ID}/d1/database`);
    const r2 = await h.request(`/client/v4/accounts/${ACCOUNT_ID}/r2/buckets`);
    expect(d1.status).toBe(200);
    expect(r2.status).toBe(200);
  });

  it("refuses an unprefixed D1 query with the real API's 404 envelope", async () => {
    const h = open();
    const path = `/accounts/${ACCOUNT_ID}/d1/database/${DB_ID}/query`;
    const response = await h.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql: "CREATE TABLE unprefixed (id INTEGER PRIMARY KEY)" }),
    });

    const body = await expectCloudflare404(response);
    expect(body.errors[0]).toEqual({
      code: 7003,
      message: `Could not route to ${path}, perhaps your object identifier is invalid?`,
    });

    // The statement must not have reached the engine.
    const check = await h.request(`/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DB_ID}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql: "SELECT name FROM sqlite_master WHERE name = 'unprefixed'" }),
    });
    const rows = (await check.json()) as { result: Array<{ results: unknown[] }> };
    expect(rows.result[0].results).toEqual([]);
  });

  it("refuses an unprefixed D1 create without creating the database", async () => {
    const h = open();
    const response = await h.request(`/accounts/${ACCOUNT_ID}/d1/database`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "created_without_the_prefix" }),
    });
    await expectCloudflare404(response);

    const listed = await h.json<{ result: Array<{ name: string }> }>(`/client/v4/accounts/${ACCOUNT_ID}/d1/database`);
    expect(listed.result.map((row) => row.name)).toEqual(["app_dev"]);
  });

  it("refuses unprefixed R2 bucket routes without creating the bucket", async () => {
    const h = open();
    await expectCloudflare404(await h.request(`/accounts/${ACCOUNT_ID}/r2/buckets`));
    await expectCloudflare404(
      await h.request(`/accounts/${ACCOUNT_ID}/r2/buckets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "created-without-the-prefix" }),
      }),
    );
    await expectCloudflare404(
      await h.request(`/accounts/${ACCOUNT_ID}/r2/buckets/app-uploads/objects/note.txt`, {
        method: "PUT",
        body: "hello",
      }),
    );

    const listed = await h.json<{ result: { buckets: Array<{ name: string }> } }>(
      `/client/v4/accounts/${ACCOUNT_ID}/r2/buckets`,
    );
    expect(listed.result.buckets.map((bucket) => bucket.name)).toEqual(["app-uploads"]);
  });

  it("names the missing prefix in a second error entry, leaving the first authentic", async () => {
    const h = open();
    const body = await expectCloudflare404(await h.request(`/accounts/${ACCOUNT_ID}/d1/database`));
    expect(body.errors).toHaveLength(2);
    expect(body.errors[0].code).toBe(7003);
    expect(body.errors[0].message).not.toContain("emulate");
    expect(body.errors[1].message).toContain("/client/v4");
    expect(body.errors[1].message).toContain("CLOUDFLARE_API_BASE_URL");
    expect(body.errors[1].documentation_url).toBeTruthy();
  });

  it("does not add the hint to paths that are not the REST surface", async () => {
    const h = open();

    // An account-scoped path the real API would also reject: one error, no hint.
    const workers = await expectCloudflare404(await h.request(`/accounts/${ACCOUNT_ID}/workers/scripts`));
    expect(workers.errors).toHaveLength(1);
    expect(workers.errors[0].code).toBe(7003);

    // Already prefixed, so the prefix cannot be the problem.
    const prefixed = await expectCloudflare404(await h.request(`/client/v4/accounts/${ACCOUNT_ID}/d1/nope`));
    expect(prefixed.errors).toHaveLength(1);
    expect(prefixed.errors[0].code).toBe(7003);

    // Not account-scoped: the real API answers this one differently.
    const root = await expectCloudflare404(await h.request("/accounts"));
    expect(root.errors).toEqual([{ code: 10404, message: "No route for that URI" }]);
  });

  it("leaves the S3 front door and the control plane alone", async () => {
    const h = open();

    // SigV4 signs the pathname, so the S3 endpoint keeps its own path and is
    // not part of the REST API. The unsigned request below is rejected by
    // Miniflare's own S3 server, in XML, which proves it reached the front door
    // rather than the REST catch-all.
    const s3 = await h.request(`${S3_ENDPOINT_PATH}/app-uploads`);
    expect(s3.status).not.toBe(404);
    expect(s3.headers.get("Content-Type")).toContain("application/xml");
    expect(await s3.text()).toContain("<Error>");

    const control = await h.request("/_cloudfault");
    expect(control.status).toBe(200);
  });
});
