import type { RouteContext, InspectorTab } from "@emulators/core";
import { renderInspectorPage, escapeHtml } from "@emulators/core";
import { getCloudflareStore } from "../store.js";
import { getFaultPlan } from "../faults.js";

const SERVICE_LABEL = "Cloudflare";

const TABS: InspectorTab[] = [
  { id: "d1", label: "D1", href: "/_inspector?tab=d1" },
  { id: "r2", label: "R2", href: "/_inspector?tab=r2" },
  { id: "operations", label: "Operations", href: "/_inspector?tab=operations" },
  { id: "faults", label: "Faults", href: "/_inspector?tab=faults" },
];

function emptyRow(columns: number, label: string): string {
  return `<tr><td colspan="${columns}"><div class="inspector-empty">${escapeHtml(label)}</div></td></tr>`;
}

export function inspectorRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;

  app.get("/_inspector", (c) => {
    const tab = c.req.query("tab") ?? "d1";
    const cf = getCloudflareStore(store);
    let contentHtml = "";

    if (tab === "d1") {
      const databases = cf.databases.all();
      const rows = databases
        .map(
          (row) => `<tr>
            <td>${escapeHtml(row.name)}</td>
            <td><code>${escapeHtml(row.uuid)}</code></td>
            <td>${row.num_tables}</td>
            <td>${row.file_size}</td>
            <td>${escapeHtml(row.read_replication_mode)}</td>
            <td>${escapeHtml(row.created_at)}</td>
          </tr>`,
        )
        .join("\n");
      contentHtml = `
        <div class="inspector-section">
          <h2>D1 databases (${databases.length})</h2>
          <table class="inspector-table">
            <thead><tr><th>Name</th><th>UUID</th><th>Tables</th><th>Size</th><th>Replication</th><th>Created</th></tr></thead>
            <tbody>${rows || emptyRow(6, "No databases")}</tbody>
          </table>
        </div>`;
    } else if (tab === "r2") {
      const buckets = cf.buckets.all();
      const rows = buckets
        .map(
          (row) => `<tr>
            <td>${escapeHtml(row.name)}</td>
            <td>${escapeHtml(row.location)}</td>
            <td>${escapeHtml(row.storage_class)}</td>
            <td><code>${escapeHtml(row.s3_access_key_id || "-")}</code></td>
            <td>${escapeHtml(row.created_at)}</td>
          </tr>`,
        )
        .join("\n");
      contentHtml = `
        <div class="inspector-section">
          <h2>R2 buckets (${buckets.length})</h2>
          <table class="inspector-table">
            <thead><tr><th>Bucket</th><th>Location</th><th>Storage class</th><th>S3 access key</th><th>Created</th></tr></thead>
            <tbody>${rows || emptyRow(5, "No buckets")}</tbody>
          </table>
        </div>`;
    } else if (tab === "operations") {
      const operations = cf.operations.all().slice(-200).reverse();
      const rows = operations
        .map(
          (row) => `<tr>
            <td><code>${escapeHtml(row.token)}</code></td>
            <td>${escapeHtml(row.operation)}</td>
            <td>${escapeHtml(row.resource)}</td>
            <td><span class="badge">${escapeHtml(row.actual)}</span></td>
            <td>${escapeHtml(row.observed ?? "-")}</td>
            <td>${row.version ?? "-"}</td>
            <td>${escapeHtml(row.fault_kind ?? "-")}</td>
          </tr>`,
        )
        .join("\n");
      contentHtml = `
        <div class="inspector-section">
          <h2>Operations (${operations.length})</h2>
          <p class="inspector-empty">The oracle ledger: what actually happened, keyed by the caller-minted token. "actual" is recorded after the engine ran, never inferred from a status code.</p>
          <table class="inspector-table">
            <thead><tr><th>Token</th><th>Operation</th><th>Resource</th><th>Actual</th><th>Observed</th><th>Version</th><th>Fault</th></tr></thead>
            <tbody>${rows || emptyRow(7, "No operations recorded")}</tbody>
          </table>
        </div>`;
    } else if (tab === "faults") {
      const plan = getFaultPlan();
      const planRows = plan.perturbations
        .map(
          (perturbation) => `<tr>
            <td><code>${escapeHtml(perturbation.id)}</code></td>
            <td>${escapeHtml(perturbation.kind)}</td>
            <td>${escapeHtml(perturbation.phase ?? "semantic variation")}</td>
            <td>${escapeHtml(perturbation.target)}</td>
            <td>${perturbation.maxActivations ?? 1}</td>
          </tr>`,
        )
        .join("\n");
      const activationRows = plan.activations
        .slice(-200)
        .reverse()
        .map(
          (activation) => `<tr>
            <td><code>${escapeHtml(activation.perturbationId)}</code></td>
            <td>${escapeHtml(activation.kind)}</td>
            <td>${escapeHtml(activation.operation)}</td>
            <td>${escapeHtml(activation.resource)}</td>
            <td>${activation.occurrence}</td>
            <td><code>${escapeHtml(activation.token)}</code></td>
          </tr>`,
        )
        .join("\n");
      contentHtml = `
        <div class="inspector-section">
          <h2>Active plan (${plan.perturbations.length})</h2>
          <table class="inspector-table">
            <thead><tr><th>ID</th><th>Kind</th><th>Phase</th><th>Target</th><th>Max activations</th></tr></thead>
            <tbody>${planRows || emptyRow(5, "No perturbations planned")}</tbody>
          </table>
        </div>
        <div class="inspector-section">
          <h2>Activations (${plan.activations.length})</h2>
          <table class="inspector-table">
            <thead><tr><th>ID</th><th>Kind</th><th>Operation</th><th>Resource</th><th>Occurrence</th><th>Token</th></tr></thead>
            <tbody>${activationRows || emptyRow(6, "No faults activated")}</tbody>
          </table>
        </div>`;
    }

    return c.html(renderInspectorPage("Inspector", TABS, tab, contentHtml, SERVICE_LABEL));
  });
}
