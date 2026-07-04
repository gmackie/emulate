import type { RouteContext } from "@emulators/core";
import { renderInspectorPage, escapeHtml, type InspectorTab } from "@emulators/core";
import { getPostgresStore } from "../store.js";
import { getPgliteInstance } from "../server.js";

const SERVICE_LABEL = "PostgreSQL";

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

const TABS: InspectorTab[] = [
  { id: "overview", label: "Overview", href: "/" },
  { id: "tables", label: "Tables", href: "/tables" },
  { id: "query", label: "Query", href: "/query" },
];

function statusBadge(running: boolean): string {
  return running
    ? '<span class="badge badge-granted">running</span>'
    : '<span class="badge badge-denied">stopped</span>';
}

export function inspectorRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ps = () => getPostgresStore(store);

  app.get("/", async (c) => {
    const pglite = getPgliteInstance();
    const databases = ps().databases.all();

    const statsRows: Array<[string, string]> = [
      ["Status", pglite ? "Running" : "Stopped"],
      ["Engine", "PGlite (Postgres 17.4 / WASM)"],
      ["Wire Protocol", "localhost:5432"],
      ["Databases", String(databases.length)],
    ];

    if (pglite) {
      try {
        const result = await pglite.exec("SELECT count(*) as count FROM pg_tables WHERE schemaname = 'public'");
        const tableCount = result[0]?.rows?.[0]?.count ?? 0;
        statsRows.push(["Tables (public)", String(tableCount)]);
      } catch {
        // ignore
      }

      try {
        const result = await pglite.exec(
          "SELECT extname FROM pg_extension WHERE extname != 'plpgsql' ORDER BY extname",
        );
        const extensions = result[0]?.rows?.map((r: any) => r.extname) ?? [];
        if (extensions.length > 0) {
          statsRows.push(["Extensions", extensions.join(", ")]);
        }
      } catch {
        // ignore
      }
    }

    const tableHtml = statsRows
      .map(
        ([key, value]) => `<tr><td style="font-weight:600">${escapeHtml(key)}</td><td>${escapeHtml(value)}</td></tr>`,
      )
      .join("");

    const dbListHtml =
      databases.length > 0
        ? databases
            .map(
              (db) =>
                `<div class="org-row">
  <span class="org-icon">D</span>
  <span class="org-name">${escapeHtml(db.name)}</span>
  ${db.extensions.length > 0 ? `<span class="user-meta">${escapeHtml(db.extensions.join(", "))}</span>` : ""}
</div>`,
            )
            .join("")
        : '<p class="empty">No databases configured</p>';

    const body = `
<div class="inspector-section">
  <h2>Server Status ${statusBadge(pglite !== null)}</h2>
  <table class="inspector-table">
    <tbody>${tableHtml}</tbody>
  </table>
</div>
<div class="inspector-section">
  <h2>Databases</h2>
  ${dbListHtml}
</div>
<div class="inspector-section">
  <form method="post" action="/reset">
    <button type="submit" class="btn-revoke">Reset Database (drop all tables)</button>
  </form>
</div>`;

    return c.html(renderInspectorPage("PostgreSQL Admin", TABS, "overview", body, SERVICE_LABEL));
  });

  app.get("/tables", async (c) => {
    const pglite = getPgliteInstance();

    if (!pglite) {
      const body = '<div class="inspector-section"><p class="empty">PostgreSQL is not running</p></div>';
      return c.html(renderInspectorPage("Tables", TABS, "tables", body, SERVICE_LABEL));
    }

    let body = "";

    try {
      const result = await pglite.exec(`
        SELECT tablename,
               pg_size_pretty(pg_total_relation_size(quote_ident(tablename)::text)) as size
        FROM pg_tables
        WHERE schemaname = 'public'
        ORDER BY tablename
      `);
      const tables = result[0]?.rows ?? [];

      if (tables.length === 0) {
        body =
          '<div class="inspector-section"><p class="empty">No tables in public schema. Run migrations first.</p></div>';
      } else {
        for (const table of tables as Array<{ tablename: string; size: string }>) {
          const colResult = await pglite.query(
            `SELECT column_name, data_type, is_nullable, column_default
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = $1
            ORDER BY ordinal_position`,
            [table.tablename],
          );
          const columns = colResult.rows ?? [];

          const countResult = await pglite.query(`SELECT count(*)::int as count FROM ${quoteIdent(table.tablename)}`);
          const rowCount = (countResult.rows?.[0] as any)?.count ?? 0;

          const columnRows = (
            columns as Array<{
              column_name: string;
              data_type: string;
              is_nullable: string;
              column_default: string | null;
            }>
          )
            .map(
              (col) =>
                `<tr>
  <td>${escapeHtml(col.column_name)}</td>
  <td>${escapeHtml(col.data_type)}</td>
  <td>${col.is_nullable === "YES" ? '<span class="badge badge-requested">nullable</span>' : '<span class="badge badge-granted">required</span>'}</td>
  <td class="user-meta">${col.column_default ? escapeHtml(col.column_default) : ""}</td>
</tr>`,
            )
            .join("");

          body += `
<div class="inspector-section">
  <h2>${escapeHtml(table.tablename)}</h2>
  <div class="user-meta" style="margin-bottom:8px">${rowCount} rows · ${escapeHtml(table.size)}</div>
  <table class="inspector-table">
    <thead><tr><th>Column</th><th>Type</th><th>Nullable</th><th>Default</th></tr></thead>
    <tbody>${columnRows}</tbody>
  </table>
</div>`;
        }
      }
    } catch (err) {
      body = `<div class="inspector-section"><p class="empty">Error reading tables: ${escapeHtml(String(err))}</p></div>`;
    }

    return c.html(renderInspectorPage("Tables", TABS, "tables", body, SERVICE_LABEL));
  });

  app.get("/query", (c) => {
    const previousQuery = c.req.query("q") ?? "";
    const body = `
<div class="inspector-section">
  <h2>Run Query</h2>
  <form method="post" action="/query">
    <textarea name="sql" class="checkout-input" rows="6" placeholder="SELECT * FROM ..." style="font-family:monospace;resize:vertical;min-height:120px">${escapeHtml(previousQuery)}</textarea>
    <div style="margin-top:8px">
      <button type="submit" class="checkout-pay-btn" style="max-width:200px">Execute</button>
    </div>
  </form>
  <div class="info-text" style="margin-top:12px">
    Run read-only or write queries against the emulated database.
    Results appear below after execution.
  </div>
</div>`;

    return c.html(renderInspectorPage("Query", TABS, "query", body, SERVICE_LABEL));
  });

  app.post("/query", async (c) => {
    const pglite = getPgliteInstance();

    if (!pglite) {
      const body = '<div class="inspector-section"><p class="empty">PostgreSQL is not running</p></div>';
      return c.html(renderInspectorPage("Query", TABS, "query", body, SERVICE_LABEL));
    }

    const formData = await c.req.parseBody();
    const sql = String(formData.sql ?? "");

    let resultHtml = "";

    try {
      const result = await pglite.exec(sql);
      const firstResult = result[0];

      if (!firstResult || !firstResult.rows || firstResult.rows.length === 0) {
        const affected = firstResult?.affectedRows ?? 0;
        resultHtml = `<div class="inspector-section">
  <h2>Result</h2>
  <p class="info-text">Query executed successfully. ${affected > 0 ? `${affected} row(s) affected.` : "No rows returned."}</p>
</div>`;
      } else {
        const fields = firstResult.fields?.map((f: any) => f.name) ?? Object.keys(firstResult.rows[0] as any);
        const headerCells = fields.map((f: string) => `<th>${escapeHtml(f)}</th>`).join("");
        const bodyRows = firstResult.rows
          .slice(0, 100)
          .map((row: any) => {
            const cells = fields
              .map((f: string) => {
                const val = row[f];
                return `<td>${val === null ? '<span class="user-meta">NULL</span>' : escapeHtml(String(val))}</td>`;
              })
              .join("");
            return `<tr>${cells}</tr>`;
          })
          .join("");

        const truncated =
          firstResult.rows.length > 100
            ? `<p class="info-text">Showing first 100 of ${firstResult.rows.length} rows</p>`
            : `<p class="info-text">${firstResult.rows.length} row(s)</p>`;

        resultHtml = `<div class="inspector-section">
  <h2>Result</h2>
  ${truncated}
  <table class="inspector-table">
    <thead><tr>${headerCells}</tr></thead>
    <tbody>${bodyRows}</tbody>
  </table>
</div>`;
      }
    } catch (err) {
      resultHtml = `<div class="inspector-section">
  <h2>Error</h2>
  <p class="info-text" style="color:#ff4444">${escapeHtml(String(err))}</p>
</div>`;
    }

    const body = `
<div class="inspector-section">
  <h2>Run Query</h2>
  <form method="post" action="/query">
    <textarea name="sql" class="checkout-input" rows="6" style="font-family:monospace;resize:vertical;min-height:120px">${escapeHtml(sql)}</textarea>
    <div style="margin-top:8px">
      <button type="submit" class="checkout-pay-btn" style="max-width:200px">Execute</button>
    </div>
  </form>
</div>
${resultHtml}`;

    return c.html(renderInspectorPage("Query", TABS, "query", body, SERVICE_LABEL));
  });
}
