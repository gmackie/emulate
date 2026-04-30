import type { RouteContext } from "@emulators/core";
import {
  renderInspectorPage,
  escapeHtml,
  type InspectorTab,
} from "@emulators/core";
import { getRedisStore } from "../store.js";
import { getRedisServer } from "../server.js";

const SERVICE_LABEL = "Redis";

const TABS: InspectorTab[] = [
  { id: "overview", label: "Overview", href: "/" },
  { id: "keys", label: "Keys", href: "/keys" },
];

function statusBadge(running: boolean): string {
  return running
    ? '<span class="badge badge-granted">running</span>'
    : '<span class="badge badge-denied">stopped</span>';
}

export function inspectorRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const rs = () => getRedisStore(store);

  app.get("/", (c) => {
    const server = getRedisServer();
    const instances = rs().instances.all();
    const instance = instances[0];

    const statsRows: Array<[string, string]> = [
      ["Status", server ? "Running" : "Stopped"],
      ["Engine", "Redis 7.x (redis-memory-server)"],
      ["Wire Protocol", `${instance?.host ?? "localhost"}:${instance?.port ?? 6379}`],
    ];

    if (instance?.created_at) {
      statsRows.push(["Started At", instance.created_at]);
    }

    const tableHtml = statsRows
      .map(
        ([key, value]) =>
          `<tr><td style="font-weight:600">${escapeHtml(key)}</td><td>${escapeHtml(value)}</td></tr>`,
      )
      .join("");

    const body = `
<div class="inspector-section">
  <h2>Server Status ${statusBadge(server !== null)}</h2>
  <table class="inspector-table">
    <tbody>${tableHtml}</tbody>
  </table>
</div>
<div class="inspector-section">
  <h2>Connection</h2>
  <div class="s-card">
    <div class="info-text">
      Connect with any Redis client:<br>
      <code style="color:#33ff00">redis-cli -h ${escapeHtml(instance?.host ?? "localhost")} -p ${instance?.port ?? 6379}</code>
    </div>
    <div class="info-text" style="margin-top:8px">
      <code style="color:#33ff00">REDIS_URL=redis://${escapeHtml(instance?.host ?? "localhost")}:${instance?.port ?? 6379}</code>
    </div>
  </div>
</div>
<div class="inspector-section">
  <h2>Actions</h2>
  <div style="display:flex;gap:8px">
    <form method="post" action="/flush">
      <button type="submit" class="btn-revoke">Flush All Data</button>
    </form>
    <form method="post" action="/reset">
      <button type="submit" class="btn-revoke">Reset Server</button>
    </form>
  </div>
</div>`;

    return c.html(
      renderInspectorPage("Redis Admin", TABS, "overview", body, SERVICE_LABEL),
    );
  });

  app.get("/keys", (c) => {
    const server = getRedisServer();

    if (!server) {
      const body =
        '<div class="inspector-section"><p class="empty">Redis is not running</p></div>';
      return c.html(
        renderInspectorPage("Keys", TABS, "keys", body, SERVICE_LABEL),
      );
    }

    const pattern = c.req.query("pattern") ?? "*";

    const body = `
<div class="inspector-section">
  <h2>Key Browser</h2>
  <form method="get" action="/keys" style="display:flex;gap:8px;margin-bottom:16px">
    <input
      type="text"
      name="pattern"
      value="${escapeHtml(pattern)}"
      class="checkout-input"
      placeholder="Pattern (e.g., cache:* or *)"
      style="font-family:monospace"
    />
    <button type="submit" class="checkout-pay-btn" style="max-width:120px;white-space:nowrap">Scan</button>
  </form>
  <div class="info-text">
    Key scanning requires a Redis client connection. Use the wire protocol to connect
    a client, then use <code style="color:#33ff00">SCAN 0 MATCH ${escapeHtml(pattern)}</code> to browse keys.
  </div>
  <div class="info-text" style="margin-top:8px">
    Common commands:<br>
    <code style="color:#33ff00">KEYS *</code> — list all keys<br>
    <code style="color:#33ff00">GET &lt;key&gt;</code> — get a string value<br>
    <code style="color:#33ff00">HGETALL &lt;key&gt;</code> — get all hash fields<br>
    <code style="color:#33ff00">LRANGE &lt;key&gt; 0 -1</code> — get all list elements<br>
    <code style="color:#33ff00">INFO</code> — server info and stats<br>
    <code style="color:#33ff00">DBSIZE</code> — number of keys in current database
  </div>
</div>`;

    return c.html(
      renderInspectorPage("Keys", TABS, "keys", body, SERVICE_LABEL),
    );
  });
}
