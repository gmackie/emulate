import { describe, it, expect, afterEach } from "vitest";
import { createHarness, ACCOUNT_ID, type Harness, type D1Envelope } from "./helpers.js";

const DB_ID = "11111111-1111-4111-8111-111111111111";

let harness: Harness | undefined;

function open(): Harness {
  harness = createHarness({ d1: { databases: [{ name: "app_dev", id: DB_ID }] } });
  return harness;
}

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
});

describe("D1 REST surface", () => {
  it("creates, lists and describes a database the way wrangler expects", async () => {
    const h = open();

    const created = await h.json<{ success: boolean; result: { uuid: string; name: string; version: string } }>(
      `/client/v4/accounts/${ACCOUNT_ID}/d1/database`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "created_by_wrangler" }),
      },
    );
    expect(created.success).toBe(true);
    expect(created.result.name).toBe("created_by_wrangler");
    expect(created.result.uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.result.version).toBe("production");

    const listed = await h.json<{
      success: boolean;
      result: Array<{ uuid: string; name: string }>;
      result_info: { total_count: number };
    }>(`/client/v4/accounts/${ACCOUNT_ID}/d1/database`);
    expect(listed.success).toBe(true);
    expect(listed.result.map((row) => row.name).sort()).toEqual(["app_dev", "created_by_wrangler"]);
    expect(listed.result_info.total_count).toBe(2);
    // The list shape is deliberately reduced: no file_size, no num_tables.
    expect(listed.result[0]).not.toHaveProperty("file_size");

    const info = await h.json<{ result: { num_tables: number; read_replication: { mode: string } } }>(
      `/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DB_ID}`,
    );
    expect(info.result.read_replication.mode).toBe("auto");
    expect(typeof info.result.num_tables).toBe("number");
  });

  it("refuses a duplicate name with the code wrangler renders", async () => {
    const h = open();
    const response = await h.request(`/client/v4/accounts/${ACCOUNT_ID}/d1/database`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "app_dev" }),
    });
    const body = (await response.json()) as { success: boolean; errors: Array<{ code: number }> };
    expect(body.success).toBe(false);
    expect(body.errors[0].code).toBe(7502);
  });

  it("executes a multi-statement /query as one batch and reports real meta", async () => {
    const h = open();
    const response = await h.query(
      DB_ID,
      [
        "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT);",
        "INSERT INTO t (name) VALUES ('a');",
        "INSERT INTO t (name) VALUES ('b');",
        "SELECT name FROM t ORDER BY id;",
      ].join("\n"),
    );
    const body = (await response.json()) as D1Envelope;
    expect(body.success).toBe(true);
    expect(body.result).toHaveLength(4);
    expect(body.result[3].results).toEqual([{ name: "a" }, { name: "b" }]);
    const meta = body.result[1].meta;
    expect(meta.changes).toBe(1);
    expect(meta.rows_written).toBe(1);
    expect(meta.served_by).toBe("miniflare.db");
    // Miniflare clamps its own timer to 0; the emulator synthesizes a duration.
    expect(typeof meta.duration).toBe("number");
    expect(meta).toHaveProperty("served_by_colo");
    expect(meta).toHaveProperty("timings");
  });

  it("binds parameters for a single statement", async () => {
    const h = open();
    await h.query(DB_ID, "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
    await h.query(DB_ID, "INSERT INTO t (name) VALUES (?)", ["bound"]);
    const response = await h.query(DB_ID, "SELECT name FROM t WHERE name = ?", ["bound"]);
    const body = (await response.json()) as D1Envelope;
    expect(body.result[0].results).toEqual([{ name: "bound" }]);
  });

  it("supports RETURNING", async () => {
    const h = open();
    await h.query(DB_ID, "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
    const response = await h.query(DB_ID, "INSERT INTO t (name) VALUES ('x') RETURNING id, name");
    const body = (await response.json()) as D1Envelope;
    expect(body.result[0].results).toEqual([{ id: 1, name: "x" }]);
  });

  it("keeps the batch atomic when a later statement fails", async () => {
    const h = open();
    await h.query(DB_ID, "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
    const failed = await h.query(DB_ID, "INSERT INTO t (name) VALUES ('kept');\nSELECT * FROM missing_table;");
    expect(failed.status).toBe(400);
    const body = (await failed.json()) as { success: boolean; errors: Array<{ code: number; message: string }> };
    expect(body.success).toBe(false);
    expect(body.errors[0].code).toBe(7500);
    expect(body.errors[0].message).toContain("no such table");

    const after = (await (await h.query(DB_ID, "SELECT count(*) AS c FROM t")).json()) as D1Envelope;
    expect(after.result[0].results).toEqual([{ c: 0 }]);
  });

  it("rejects explicit transaction control the way D1 does", async () => {
    const h = open();
    const response = await h.query(DB_ID, "BEGIN");
    expect(response.status).toBe(400);
    const body = (await response.json()) as { errors: Array<{ message: string }> };
    expect(body.errors[0].message).toMatch(/transaction/i);
  });

  it("serves /raw as columns and rows", async () => {
    const h = open();
    await h.query(DB_ID, "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO t (name) VALUES ('z');");
    const response = await h.request(`/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DB_ID}/raw`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql: "SELECT id, name FROM t", params: [] }),
    });
    const body = (await response.json()) as {
      result: Array<{ results: { columns: string[]; rows: unknown[][] } }>;
    };
    expect(body.result[0].results.columns).toEqual(["id", "name"]);
    expect(body.result[0].results.rows).toEqual([[1, "z"]]);
  });

  it("accepts the { batch } request shape", async () => {
    const h = open();
    const response = await h.request(`/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DB_ID}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        batch: [
          { sql: "CREATE TABLE t (id INTEGER PRIMARY KEY)" },
          { sql: "INSERT INTO t (id) VALUES (?)", params: [7] },
        ],
      }),
    });
    const body = (await response.json()) as D1Envelope;
    expect(body.success).toBe(true);
    expect(body.result).toHaveLength(2);
  });

  it("answers a missing database with 7404 and never a bare HTTP error", async () => {
    const h = open();
    const response = await h.query("does-not-exist", "SELECT 1");
    expect(response.status).toBe(404);
    const body = (await response.json()) as { success: boolean; errors: Array<{ code: number }> };
    expect(body.success).toBe(false);
    expect(body.errors[0].code).toBe(7404);
  });

  it("deletes a database", async () => {
    const h = open();
    const response = await h.request(`/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DB_ID}`, { method: "DELETE" });
    expect(response.status).toBe(200);
    const listed = await h.json<{ result: unknown[] }>(`/client/v4/accounts/${ACCOUNT_ID}/d1/database`);
    expect(listed.result).toHaveLength(0);
  });
});
