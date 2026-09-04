import type { RouteContext } from "@emulators/core";
import { getFaultPlan, resetFaultPlan, PlanRejectedError, FAULT_KINDS, CONTRACT_PROBE_KINDS } from "../faults.js";
import type { Perturbation } from "../faults.js";
import { Oracle } from "../oracle.js";
import { getCloudflareStore } from "../store.js";
import { resetCloudflareEngine, getEngine } from "../engine.js";
import { isRecord, readJsonBody } from "../helpers.js";

/**
 * The control and oracle planes.
 *
 * Everything lives under `/_cloudfault` so it can never collide with a
 * Cloudflare API path. The control plane mirrors CloudFault's
 * `ScenarioController` closely enough that a `Perturbation[]` can be posted
 * verbatim; the oracle plane is the part that does not exist anywhere else, and
 * is the reason this emulator is worth more than `wrangler dev`.
 */
export function controlRoutes(ctx: RouteContext): void {
  const { app } = ctx;
  const oracle = new Oracle(ctx.store);

  app.get("/_cloudfault", (c) =>
    c.json({
      control: {
        "POST /_cloudfault/plan": "{ perturbations: Perturbation[], allowContractProbes?: boolean } -> 204",
        "DELETE /_cloudfault/plan": "-> 204",
        "GET /_cloudfault/plan": "-> { perturbations }",
        "GET /_cloudfault/events": "-> { activations: Activation[] }",
        "POST /_cloudfault/reset": "-> 204 (engine + oracle ledger + plan)",
      },
      oracle: {
        "GET /_cloudfault/outcome/:token": "-> PrivilegedOutcome | 404",
        "GET /_cloudfault/version/:resource": "-> { resource, version }",
        "GET /_cloudfault/snapshot": "-> { databases, buckets, operations, versions }",
      },
      tokenHeader: "x-emulate-operation",
      tokens:
        "Mint the token yourself and send it on the request. The emulator echoes it on the response, but under commit-then-response-lost there is no response to read it from, so a caller-minted token is the only one that can still be asked about.",
      kinds: FAULT_KINDS,
      contractProbes: {
        kinds: [...CONTRACT_PROBE_KINDS],
        note: "These model nothing Cloudflare does. Real D1 batches are atomic and real R2 list is strongly consistent. They discover undocumented reliance on those guarantees, and are refused unless the plan sets allowContractProbes: true.",
      },
    }),
  );

  app.post("/_cloudfault/plan", async (c) => {
    const body = await readJsonBody(c);
    const raw = body.perturbations;
    if (!Array.isArray(raw)) {
      return c.json({ error: "`perturbations` must be an array" }, 400);
    }
    const perturbations: Perturbation[] = [];
    for (const entry of raw) {
      if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.kind !== "string") {
        return c.json({ error: "each perturbation needs a string `id` and `kind`" }, 400);
      }
      perturbations.push({ ...entry, target: typeof entry.target === "string" ? entry.target : "*" } as Perturbation);
    }
    try {
      getFaultPlan().set(perturbations, { allowContractProbes: body.allowContractProbes === true });
    } catch (error) {
      if (error instanceof PlanRejectedError) return c.json({ error: error.message }, 400);
      throw error;
    }
    return c.body(null, 204);
  });

  app.get("/_cloudfault/plan", (c) => c.json({ perturbations: getFaultPlan().perturbations }));

  app.delete("/_cloudfault/plan", (c) => {
    getFaultPlan().clear();
    return c.body(null, 204);
  });

  app.get("/_cloudfault/events", (c) => c.json({ activations: getFaultPlan().activations }));

  app.get("/_cloudfault/outcome/:token", (c) => {
    const outcome = oracle.outcomeFor(c.req.param("token"));
    // Absence degrades to 404, never to a guess. A caller that cannot get an
    // answer must record "unknown"; inferring "committed" from a 200 is exactly
    // the shortcut this endpoint exists to remove.
    if (!outcome) return c.json({ error: "unknown operation token" }, 404);
    return c.json(outcome);
  });

  app.get("/_cloudfault/version/:resource{.+}", (c) => {
    const resource = c.req.param("resource");
    return c.json({ resource, version: oracle.versionOf(resource) ?? null });
  });

  app.get("/_cloudfault/snapshot", (c) => c.json(oracle.snapshot()));

  app.post("/_cloudfault/reset", async (c) => {
    oracle.reset();
    resetFaultPlan();
    const cf = getCloudflareStore(ctx.store);
    const databases = cf.databases.all();
    const buckets = cf.buckets.all();
    await resetCloudflareEngine();
    const engine = getEngine();
    for (const row of databases) await engine.addD1Database(row.binding, row.uuid);
    for (const row of buckets) {
      await engine.addR2Bucket(row.binding, row.name, {
        accessKeyId: row.s3_access_key_id,
        secretAccessKey: row.s3_secret_access_key,
      });
    }
    return c.body(null, 204);
  });
}
