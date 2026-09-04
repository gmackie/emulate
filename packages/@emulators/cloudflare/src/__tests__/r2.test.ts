import { describe, it, expect, afterEach } from "vitest";
import { createHarness, ACCOUNT_ID, type Harness } from "./helpers.js";

let harness: Harness | undefined;

function open(): Harness {
  harness = createHarness({
    r2: { buckets: [{ name: "app-uploads", s3_access_key_id: "AKIAEMULATE", s3_secret_access_key: "emulate-secret" }] },
  });
  return harness;
}

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
});

describe("R2 REST surface", () => {
  it("lists seeded buckets under result.buckets, the shape wrangler reads", async () => {
    const h = open();
    const body = await h.json<{ success: boolean; result: { buckets: Array<{ name: string }> } }>(
      `/client/v4/accounts/${ACCOUNT_ID}/r2/buckets`,
    );
    expect(body.success).toBe(true);
    expect(body.result.buckets.map((bucket) => bucket.name)).toEqual(["app-uploads"]);
  });

  it("creates a bucket and rejects a duplicate with HTTP 400", async () => {
    const h = open();
    const created = await h.request(`/client/v4/accounts/${ACCOUNT_ID}/r2/buckets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "created-by-wrangler" }),
    });
    expect(created.status).toBe(200);

    const duplicate = await h.request(`/client/v4/accounts/${ACCOUNT_ID}/r2/buckets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "created-by-wrangler" }),
    });
    expect(duplicate.status).toBe(400);
    const body = (await duplicate.json()) as { success: boolean; errors: Array<{ code: number }> };
    expect(body.success).toBe(false);
    expect(body.errors[0].code).toBe(10004);
  });

  it("rejects an invalid bucket name", async () => {
    const h = open();
    const response = await h.request(`/client/v4/accounts/${ACCOUNT_ID}/r2/buckets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Not Valid" }),
    });
    expect(response.status).toBe(400);
  });

  it("round-trips a binary object through the REST object endpoints", async () => {
    const h = open();
    // A PNG header, chosen because the aws emulator's string-bodied S3 store
    // would corrupt exactly this.
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe]);
    const put = await h.request(`/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/app-uploads/objects/nested/logo.png`, {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: bytes,
    });
    expect(put.status).toBe(200);

    const got = await h.request(`/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/app-uploads/objects/nested/logo.png`);
    expect(got.status).toBe(200);
    expect(got.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes);

    const deleted = await h.request(
      `/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/app-uploads/objects/nested/logo.png`,
      { method: "DELETE" },
    );
    expect(deleted.status).toBe(200);

    const missing = await h.request(`/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/app-uploads/objects/nested/logo.png`);
    expect(missing.status).toBe(404);
    const body = (await missing.json()) as { errors: Array<{ code: number }> };
    expect(body.errors[0].code).toBe(10007);
  });

  it("answers a missing bucket with 10006", async () => {
    const h = open();
    const response = await h.request(`/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/nope`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { errors: Array<{ code: number }> };
    expect(body.errors[0].code).toBe(10006);
  });
});
