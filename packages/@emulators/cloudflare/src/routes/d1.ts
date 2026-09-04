import type { Context, RouteContext } from "@emulators/core";
import { cfOk, paginate, D1_CODES } from "../envelope.js";
import { getCloudflareStore } from "../store.js";
import type { D1DatabaseRow, AppliedSubOperation } from "../entities.js";
import { getEngine, bindingNameFor, type D1Database } from "../engine.js";
import { splitSqlQuery, SqlSplitError } from "../sql-split.js";
import { Oracle } from "../oracle.js";
import { metaNumber } from "../faults.js";
import {
  API_PREFIXES,
  applyPreFault,
  beginAttempt,
  destroyedResponse,
  failEnvelope,
  jsonEnvelope,
  readJsonBody,
  sleep,
  truncatedResponse,
} from "../helpers.js";

interface D1Meta {
  served_by: string;
  served_by_colo: string;
  served_by_region: string;
  served_by_primary: boolean;
  duration: number;
  changes: number;
  last_row_id: number;
  changed_db: boolean;
  size_after: number;
  rows_read: number;
  rows_written: number;
  total_attempts: number;
  timings: { sql_duration_ms: number };
}

interface D1QueryResult {
  success: boolean;
  results: unknown;
  meta: D1Meta;
}

interface RawStatement {
  sql: string;
  params: unknown[];
}

interface ExecutionOutcome {
  results: D1QueryResult[];
  applied: AppliedSubOperation[];
  rowsWritten: number;
  changes: number;
}

function describeDatabase(row: D1DatabaseRow): Record<string, unknown> {
  return {
    uuid: row.uuid,
    name: row.name,
    version: row.version,
    created_at: row.created_at,
    file_size: row.file_size,
    num_tables: row.num_tables,
    jurisdiction: row.jurisdiction,
    running_in_region: row.running_in_region,
    read_replication: { mode: row.read_replication_mode },
  };
}

/** `list` returns a reduced row shape; the SDK's model omits size and table count. */
function describeDatabaseBrief(row: D1DatabaseRow): Record<string, unknown> {
  return {
    uuid: row.uuid,
    name: row.name,
    version: row.version,
    created_at: row.created_at,
    jurisdiction: row.jurisdiction,
  };
}

function findDatabase(ctx: RouteContext, idOrName: string): D1DatabaseRow | undefined {
  const { databases } = getCloudflareStore(ctx.store);
  return databases.findOneBy("uuid", idOrName) ?? databases.findOneBy("name", idOrName);
}

/**
 * Registering the binding is idempotent, and doing it on the request path is
 * what makes the engine's eager (fire-and-forget) start safe: a request that
 * arrives before the seed's registration has landed registers it itself rather
 * than failing on a missing binding.
 */
async function openDatabase(row: D1DatabaseRow): Promise<D1Database> {
  const engine = getEngine();
  await engine.addD1Database(row.binding, row.uuid);
  return engine.getD1(row.binding);
}

export function createDatabaseRow(ctx: RouteContext, name: string, uuid?: string): D1DatabaseRow {
  const { databases } = getCloudflareStore(ctx.store);
  const id = uuid ?? crypto.randomUUID();
  return databases.insert({
    uuid: id,
    name,
    binding: bindingNameFor("D1", id),
    version: "production",
    file_size: 0,
    num_tables: 0,
    jurisdiction: "default",
    read_replication_mode: "auto",
    running_in_region: "ENAM",
  });
}

function normalizeParams(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value;
}

/** Accept `{sql, params}` or `{batch: [{sql, params}]}`, as the REST API does. */
function readStatements(body: Record<string, unknown>): RawStatement[] | { error: string } {
  if (Array.isArray(body.batch)) {
    const out: RawStatement[] = [];
    for (const entry of body.batch) {
      if (typeof entry !== "object" || entry === null) return { error: "Invalid batch entry" };
      const sql = (entry as Record<string, unknown>).sql;
      if (typeof sql !== "string") return { error: "Each batch entry requires a `sql` string" };
      out.push({ sql, params: normalizeParams((entry as Record<string, unknown>).params) });
    }
    return out;
  }
  if (typeof body.sql !== "string") return { error: "A `sql` string is required" };
  return [{ sql: body.sql, params: normalizeParams(body.params) }];
}

interface PreparedStatement {
  sql: string;
  params: unknown[];
}

function expandStatements(raw: RawStatement[]): PreparedStatement[] | { error: string } {
  const out: PreparedStatement[] = [];
  for (const entry of raw) {
    let parts: string[];
    try {
      // Server-side splitting, as the real API documents. Never db.exec(),
      // which splits on newlines and therefore breaks every multi-line
      // CREATE TABLE drizzle-kit emits.
      parts = splitSqlQuery(entry.sql);
    } catch (error) {
      return { error: error instanceof SqlSplitError ? error.message : String(error) };
    }
    if (parts.length === 0) return { error: "SQL code did not contain a statement" };
    if (entry.params.length > 0 && parts.length > 1) {
      return { error: "Bound parameters are only supported for a single statement" };
    }
    for (const sql of parts) {
      out.push({ sql, params: parts.length === 1 ? entry.params : [] });
    }
  }
  return out;
}

function d1ErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message) return cause.message;
    return error.message;
  }
  return String(error);
}

interface MiniflareD1Result {
  success?: boolean;
  results?: unknown;
  meta?: Record<string, unknown>;
}

function toMeta(raw: Record<string, unknown> | undefined, durationMs: number): D1Meta {
  const num = (key: string): number => {
    const value = raw?.[key];
    return typeof value === "number" ? value : 0;
  };
  return {
    // Miniflare reports the constant "miniflare.db"; real D1 reports a colo id.
    // Passing it through unchanged keeps it obvious that this is an emulator.
    served_by: typeof raw?.served_by === "string" ? raw.served_by : "miniflare.db",
    // REST-only fields Miniflare does not produce. The REST spec calls the
    // first one `served_by_colo` while the Worker binding calls it
    // `served_by`, so both are emitted.
    served_by_colo: "EMU",
    served_by_region: "ENAM",
    served_by_primary: true,
    // workerd clamps performance.now(), so Miniflare's own `duration` is
    // always 0 or 1. Real D1 returns a sub-millisecond float and clients (and
    // humans reading `wrangler d1 execute` output) treat a flat 0 as broken,
    // so the value is synthesized from the emulator's wall clock instead.
    duration: durationMs,
    changes: num("changes"),
    last_row_id: num("last_row_id"),
    changed_db: raw?.changed_db === true,
    size_after: num("size_after"),
    rows_read: num("rows_read"),
    rows_written: num("rows_written"),
    total_attempts: 1,
    timings: { sql_duration_ms: durationMs },
  };
}

async function execute(db: D1Database, statements: PreparedStatement[]): Promise<ExecutionOutcome> {
  const prepared = statements.map((statement) => {
    const stmt = db.prepare(statement.sql);
    return statement.params.length > 0 ? stmt.bind(...statement.params) : stmt;
  });

  const startedAt = performance.now();
  const raw = (await db.batch(prepared)) as unknown as MiniflareD1Result[];
  const elapsed = performance.now() - startedAt;
  const per = raw.length > 0 ? elapsed / raw.length : elapsed;

  const results: D1QueryResult[] = raw.map((entry) => ({
    success: entry.success !== false,
    results: entry.results ?? [],
    meta: toMeta(entry.meta, Number(per.toFixed(4))),
  }));

  return {
    results,
    applied: results.map((_, index) => ({ index, committed: true })),
    rowsWritten: results.reduce((total, entry) => total + entry.meta.rows_written, 0),
    changes: results.reduce((total, entry) => total + entry.meta.changes, 0),
  };
}

/** `/raw` is the same engine with a different result shape. */
function toRowsAndColumns(result: D1QueryResult): D1QueryResult {
  const rows = Array.isArray(result.results) ? (result.results as Array<Record<string, unknown>>) : [];
  // Column identity comes from the first row's key order, which is the order
  // D1 produced them in. An empty result set therefore reports no columns,
  // where real D1 would still name them; that is the one place `/raw` here is
  // less faithful than the real endpoint, and it is why `db.batch` (atomic,
  // with real meta) was preferred over `.raw()` (true columns, no atomicity,
  // no meta).
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  return {
    success: result.success,
    meta: result.meta,
    results: { columns, rows: rows.map((row) => columns.map((column) => row[column])) },
  };
}

async function refreshDatabaseStats(ctx: RouteContext, row: D1DatabaseRow, db: D1Database): Promise<void> {
  try {
    const counted = (await db
      .prepare(
        "SELECT count(*) AS c FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
      )
      .first()) as { c?: number } | null;
    const sized = (await db.prepare("SELECT 1").run()) as unknown as MiniflareD1Result;
    getCloudflareStore(ctx.store).databases.update(row.id, {
      num_tables: typeof counted?.c === "number" ? counted.c : row.num_tables,
      file_size: typeof sized.meta?.size_after === "number" ? sized.meta.size_after : row.file_size,
    });
  } catch {
    // Stats are cosmetic; never fail a request over them.
  }
}

async function handleQuery(
  c: Context,
  ctx: RouteContext,
  oracle: Oracle,
  format: "objects" | "raw",
): Promise<Response> {
  const row = findDatabase(ctx, c.req.param("databaseId"));
  if (!row) {
    return failEnvelope(c, D1_CODES.NOT_FOUND, "D1_ERROR: Database not found", 404);
  }

  const resource = `d1:${row.uuid}`;
  const attempt = beginAttempt(c, { target: row.name, operation: "d1.query", resource }, oracle, "d1");

  if (attempt.pre) {
    const outcome = await applyPreFault(c, attempt.pre);
    if ("response" in outcome) {
      oracle.record(attempt.token, {
        actual: outcome.actual,
        observed: "definite-failure",
        fault: { id: attempt.pre.id, kind: attempt.pre.kind },
      });
      return outcome.response;
    }
  }

  const body = await readJsonBody(c);
  const raw = readStatements(body);
  if ("error" in raw) {
    oracle.record(attempt.token, { actual: "not-committed", observed: "definite-failure" });
    return failEnvelope(c, D1_CODES.GENERIC, `D1_ERROR: ${raw.error}`, 400);
  }
  const expanded = expandStatements(raw);
  if ("error" in expanded) {
    oracle.record(attempt.token, { actual: "not-committed", observed: "definite-failure" });
    return failEnvelope(c, D1_CODES.GENERIC, `D1_ERROR: ${expanded.error}`, 400);
  }

  // A contract probe truncates the statement list before it reaches the engine.
  // Real D1 batches are atomic, so this models nothing Cloudflare does; it
  // discovers whether the application relies on that atomicity.
  const post = attempt.post;
  const probeTruncation =
    post && (post.kind === "partial-batch-application" || post.kind === "migration-partial-then-fail")
      ? Math.max(1, Math.min(expanded.length - 1, metaNumber(post, "applyCount", Math.floor(expanded.length / 2))))
      : undefined;
  const toRun = probeTruncation === undefined ? expanded : expanded.slice(0, probeTruncation);

  const db = await openDatabase(row);
  let outcome: ExecutionOutcome;
  try {
    outcome = await execute(db, toRun);
  } catch (error) {
    // The batch is atomic, so a mid-list failure leaves nothing behind.
    oracle.record(attempt.token, {
      actual: "not-committed",
      observed: "definite-failure",
      evidence: { statements: toRun.length },
    });
    return failEnvelope(c, D1_CODES.GENERIC, `D1_ERROR: ${d1ErrorMessage(error)}`, 400);
  }

  const version = oracle.bumpVersion(resource);
  void refreshDatabaseStats(ctx, row, db);

  const applied: AppliedSubOperation[] =
    probeTruncation === undefined
      ? outcome.applied
      : expanded.map((_, index) => ({
          index,
          committed: index < probeTruncation,
          detail: index < probeTruncation ? undefined : "not reached (contract probe)",
        }));

  const results = format === "raw" ? outcome.results.map(toRowsAndColumns) : outcome.results;
  const payload = cfOk(results);
  const evidence = {
    changes: outcome.changes,
    rows_written: outcome.rowsWritten,
    last_row_id: outcome.results.at(-1)?.meta.last_row_id ?? 0,
    statements: expanded.length,
  };

  if (!post) {
    oracle.record(attempt.token, { actual: "committed", observed: "success", version, applied, evidence });
    return jsonEnvelope(c, payload);
  }

  switch (post.kind) {
    case "commit-then-response-lost":
    case "commit-then-timeout":
    case "commit-then-disconnect": {
      oracle.record(attempt.token, {
        actual: "committed",
        observed: "indeterminate",
        version,
        applied,
        evidence,
        fault: { id: post.id, kind: post.kind },
      });
      await sleep(metaNumber(post, "hangMs", 0));
      return destroyedResponse();
    }
    case "error-after-commit": {
      // The nastiest one: the caller is told it failed, and it succeeded.
      oracle.record(attempt.token, {
        actual: "committed",
        observed: "definite-failure",
        version,
        applied,
        evidence,
        fault: { id: post.id, kind: post.kind },
      });
      return failEnvelope(
        c,
        metaNumber(post, "code", D1_CODES.GENERIC),
        "D1_ERROR: Internal error. Please retry.",
        metaNumber(post, "status", 500),
      );
    }
    case "malformed-response": {
      oracle.record(attempt.token, {
        actual: "committed",
        observed: "indeterminate",
        version,
        applied,
        evidence,
        fault: { id: post.id, kind: post.kind },
      });
      return truncatedResponse(payload, metaNumber(post, "keepRatio", 0.6));
    }
    case "partial-batch-application":
    case "migration-partial-then-fail": {
      oracle.record(attempt.token, {
        actual: "committed",
        observed: "indeterminate",
        version,
        applied,
        evidence: { ...evidence, lastStatementIndex: (probeTruncation ?? expanded.length) - 1 },
        fault: { id: post.id, kind: post.kind },
      });
      return failEnvelope(c, D1_CODES.GENERIC, "D1_ERROR: Network connection lost.", 500);
    }
    default: {
      oracle.record(attempt.token, { actual: "committed", observed: "success", version, applied, evidence });
      return jsonEnvelope(c, payload);
    }
  }
}

export function d1Routes(ctx: RouteContext): void {
  const { app } = ctx;
  const oracle = new Oracle(ctx.store);
  const { databases } = getCloudflareStore(ctx.store);

  for (const prefix of API_PREFIXES) {
    const base = `${prefix}/accounts/:accountId/d1/database`;

    app.post(`${base}/:databaseId/query`, (c) => handleQuery(c, ctx, oracle, "objects"));
    app.post(`${base}/:databaseId/raw`, (c) => handleQuery(c, ctx, oracle, "raw"));

    app.get(`${base}/:databaseId/export`, async (c) => {
      const row = findDatabase(ctx, c.req.param("databaseId"));
      if (!row) return failEnvelope(c, D1_CODES.NOT_FOUND, "D1_ERROR: Database not found", 404);
      // wrangler recurses on a non-"complete" export status with no sleep and
      // no backoff, so this must complete on the first response.
      return failEnvelope(
        c,
        D1_CODES.GENERIC,
        "D1_ERROR: export is not implemented by the emulate Cloudflare emulator. Read the tables with /query instead.",
        501,
      );
    });

    app.post(`${base}/:databaseId/import`, (c) =>
      failEnvelope(
        c,
        D1_CODES.GENERIC,
        "D1_ERROR: the four-phase import protocol is not implemented by the emulate Cloudflare emulator. Use `wrangler d1 execute --remote --command`, or `--file` with `--local`.",
        501,
      ),
    );

    app.get(`${base}/:databaseId/time_travel/bookmark`, (c) =>
      failEnvelope(
        c,
        D1_CODES.GENERIC,
        "D1_ERROR: time travel is not implemented by the emulate Cloudflare emulator.",
        501,
      ),
    );

    app.post(`${base}/:databaseId/time_travel/restore`, (c) =>
      failEnvelope(
        c,
        D1_CODES.GENERIC,
        "D1_ERROR: time travel is not implemented by the emulate Cloudflare emulator.",
        501,
      ),
    );

    app.get(`${base}/:databaseId`, async (c) => {
      const row = findDatabase(ctx, c.req.param("databaseId"));
      if (!row) return failEnvelope(c, D1_CODES.NOT_FOUND, "D1_ERROR: Database not found", 404);
      const db = await openDatabase(row);
      await refreshDatabaseStats(ctx, row, db);
      const fresh = databases.get(row.id) ?? row;
      const fields = c.req.query("fields");
      const full = describeDatabase(fresh);
      if (!fields) return jsonEnvelope(c, cfOk(full));
      const wanted = new Set(fields.split(",").map((field) => field.trim()));
      const filtered: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(full)) {
        if (wanted.has(key)) filtered[key] = value;
      }
      return jsonEnvelope(c, cfOk(filtered));
    });

    app.patch(`${base}/:databaseId`, async (c) => {
      const row = findDatabase(ctx, c.req.param("databaseId"));
      if (!row) return failEnvelope(c, D1_CODES.NOT_FOUND, "D1_ERROR: Database not found", 404);
      const body = await readJsonBody(c);
      const replication = body.read_replication as { mode?: string } | undefined;
      if (replication?.mode === "auto" || replication?.mode === "disabled") {
        databases.update(row.id, { read_replication_mode: replication.mode });
      }
      return jsonEnvelope(c, cfOk(describeDatabase(databases.get(row.id) ?? row)));
    });

    app.put(`${base}/:databaseId`, async (c) => {
      const row = findDatabase(ctx, c.req.param("databaseId"));
      if (!row) return failEnvelope(c, D1_CODES.NOT_FOUND, "D1_ERROR: Database not found", 404);
      const body = await readJsonBody(c);
      const replication = body.read_replication as { mode?: string } | undefined;
      if (replication?.mode === "auto" || replication?.mode === "disabled") {
        databases.update(row.id, { read_replication_mode: replication.mode });
      }
      return jsonEnvelope(c, cfOk(describeDatabase(databases.get(row.id) ?? row)));
    });

    app.delete(`${base}/:databaseId`, async (c) => {
      const row = findDatabase(ctx, c.req.param("databaseId"));
      if (!row) return failEnvelope(c, D1_CODES.NOT_FOUND, "D1_ERROR: Database not found", 404);
      await getEngine().removeD1Database(row.binding);
      databases.delete(row.id);
      return jsonEnvelope(c, cfOk(null));
    });

    app.post(base, async (c) => {
      const body = await readJsonBody(c);
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) return failEnvelope(c, D1_CODES.GENERIC, "D1_ERROR: `name` is required", 400);
      if (databases.findOneBy("name", name)) {
        return failEnvelope(c, D1_CODES.NAME_EXISTS, "A database with that name already exists", 400);
      }
      const row = createDatabaseRow(ctx, name);
      await getEngine().addD1Database(row.binding, row.uuid);
      return jsonEnvelope(c, cfOk(describeDatabase(row)));
    });

    app.get(base, (c) => {
      const name = c.req.query("name");
      const all = databases
        .all()
        .filter((row) => (name ? row.name.includes(name) : true))
        .map(describeDatabaseBrief);
      const { rows, info } = paginate(all, Number(c.req.query("page") ?? 1), Number(c.req.query("per_page") ?? 10));
      return jsonEnvelope(c, cfOk(rows, info));
    });
  }
}
