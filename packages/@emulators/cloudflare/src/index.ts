import type { Hono } from "@emulators/core";
import type { ServicePlugin, Store, WebhookDispatcher, TokenMap, AppEnv, RouteContext } from "@emulators/core";
import { getCloudflareStore } from "./store.js";
import { configureEngine, getEngine, bindingNameFor, stopCloudflareEngine } from "./engine.js";
import { d1Routes } from "./routes/d1.js";
import { r2RestRoutes } from "./routes/r2-rest.js";
import { r2S3Routes, S3_ENDPOINT_PATH } from "./routes/r2-s3.js";
import { controlRoutes } from "./routes/control.js";
import { inspectorRoutes } from "./routes/inspector.js";

export { getCloudflareStore, type CloudflareStore } from "./store.js";
export * from "./entities.js";
export * from "./envelope.js";
export {
  getFaultPlan,
  resetFaultPlan,
  FAULT_KINDS,
  CONTRACT_PROBE_KINDS,
  type Perturbation,
  type PerturbationSelector,
  type FaultPhase,
  type FaultKind,
  type Activation,
} from "./faults.js";
export { Oracle, OPERATION_TOKEN_HEADER, mintToken, type PrivilegedOutcome, type OperationToken } from "./oracle.js";
export { splitSqlQuery, normalizeSqlLineEndings } from "./sql-split.js";
export { stopCloudflareEngine, resetCloudflareEngine, ensureEngine, configureEngine } from "./engine.js";
export { S3_ENDPOINT_PATH } from "./routes/r2-s3.js";

const DEFAULT_ACCOUNT_ID = "0000000000000000000000000000000000";

export interface CloudflareSeedConfig {
  port?: number;
  baseUrl?: string;
  account_id?: string;
  api_token?: string;
  /** Root for Miniflare's d1Persist/r2Persist. Omit to keep everything in memory. */
  persist_dir?: string;
  d1?: {
    databases?: Array<{ name: string; id?: string }>;
  };
  r2?: {
    buckets?: Array<{
      name: string;
      s3_access_key_id?: string;
      s3_secret_access_key?: string;
    }>;
  };
}

function seedDefaults(store: Store, _baseUrl: string): void {
  void getCloudflareStore(store);
}

/**
 * Materialize the R2 S3 credentials so `--generated-secrets-file` can carry
 * them, the same way GitHub app private keys are materialized.
 *
 * Miniflare only mounts its S3 front door for buckets that have credentials, so
 * every bucket needs a pair; one account-wide pair is minted and shared so a
 * single S3 client config reaches every bucket.
 */
export async function prepareSeed(
  config: Record<string, unknown>,
  generatedSecrets: Array<{ kind: string; id: string; label: string; value: string }> = [],
): Promise<{
  config: Record<string, unknown>;
  generatedSecrets: Array<{ kind: string; id: string; label: string; value: string }>;
}> {
  const typed = config as CloudflareSeedConfig;
  const restored = new Map(
    generatedSecrets.filter((secret) => secret.kind.startsWith("cloudflare.r2_s3_")).map((s) => [s.kind, s.value]),
  );

  const accessKeyId =
    restored.get("cloudflare.r2_s3_access_key_id") ?? `emulate${randomHex(12)}`.slice(0, 24).toUpperCase();
  const secretAccessKey = restored.get("cloudflare.r2_s3_secret_access_key") ?? randomHex(32);

  const next: CloudflareSeedConfig = {
    ...typed,
    r2: {
      ...typed.r2,
      buckets: (typed.r2?.buckets ?? []).map((bucket) => ({
        ...bucket,
        s3_access_key_id: bucket.s3_access_key_id ?? accessKeyId,
        s3_secret_access_key: bucket.s3_secret_access_key ?? secretAccessKey,
      })),
    },
  };

  const out = generatedSecrets.map((secret) => ({ ...secret }));
  const kinds = new Set(out.map((secret) => secret.kind));
  if (!kinds.has("cloudflare.r2_s3_access_key_id")) {
    out.push({
      kind: "cloudflare.r2_s3_access_key_id",
      id: "r2",
      label: "R2 S3 access key id",
      value: accessKeyId,
    });
  }
  if (!kinds.has("cloudflare.r2_s3_secret_access_key")) {
    out.push({
      kind: "cloudflare.r2_s3_secret_access_key",
      id: "r2",
      label: "R2 S3 secret access key",
      value: secretAccessKey,
    });
  }

  return { config: next as unknown as Record<string, unknown>, generatedSecrets: out };
}

export function needsGeneratedSecrets(config: Record<string, unknown>): boolean {
  const typed = config as CloudflareSeedConfig;
  return (typed.r2?.buckets ?? []).some((bucket) => bucket.s3_access_key_id === undefined);
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function seedFromConfig(store: Store, baseUrl: string, config: CloudflareSeedConfig): void {
  const cf = getCloudflareStore(store);
  configureEngine({ persistDir: config.persist_dir });

  store.setData("cloudflare.account_id", config.account_id ?? DEFAULT_ACCOUNT_ID);
  store.setData("cloudflare.api_token", config.api_token ?? "dev-cloudflare-token");

  const accessKeyId = config.r2?.buckets?.find((bucket) => bucket.s3_access_key_id)?.s3_access_key_id;
  const secretAccessKey = config.r2?.buckets?.find((bucket) => bucket.s3_secret_access_key)?.s3_secret_access_key;
  if (accessKeyId && secretAccessKey) {
    store.setData("cloudflare.s3_credentials", { accessKeyId, secretAccessKey });
  }

  for (const database of config.d1?.databases ?? []) {
    if (cf.databases.findOneBy("name", database.name)) continue;
    const uuid = database.id ?? crypto.randomUUID();
    cf.databases.insert({
      uuid,
      name: database.name,
      binding: bindingNameFor("D1", uuid),
      version: "production",
      file_size: 0,
      num_tables: 0,
      jurisdiction: "default",
      read_replication_mode: "auto",
      running_in_region: "ENAM",
    });
  }

  for (const bucket of config.r2?.buckets ?? []) {
    if (cf.buckets.findOneBy("name", bucket.name)) continue;
    cf.buckets.insert({
      name: bucket.name,
      binding: bindingNameFor("R2", bucket.name),
      location: "enam",
      storage_class: "Standard",
      jurisdiction: "default",
      s3_access_key_id: bucket.s3_access_key_id ?? "",
      s3_secret_access_key: bucket.s3_secret_access_key ?? "",
    });
  }

  // `seedFromConfig` is synchronous, so the engine is started eagerly here to
  // pay the workerd boot cost up front. Unlike the fork's postgres emulator,
  // failure is not merely logged and forgotten: every route awaits
  // `ensureEngine()` too, so a broken engine surfaces as a real error on the
  // first request instead of a silently dead service.
  const engine = getEngine();
  void (async () => {
    try {
      await engine.ensure();
      for (const row of cf.databases.all()) await engine.addD1Database(row.binding, row.uuid);
      for (const row of cf.buckets.all()) {
        await engine.addR2Bucket(row.binding, row.name, {
          accessKeyId: row.s3_access_key_id,
          secretAccessKey: row.s3_secret_access_key,
        });
      }
      console.log(`  cloudflare D1 + R2 ready (S3 endpoint ${baseUrl}${S3_ENDPOINT_PATH})`);
    } catch (error) {
      console.error("[cloudflare] Failed to start the Miniflare engine:", error);
    }
  })();
}

export const cloudflarePlugin: ServicePlugin = {
  name: "cloudflare",
  register(app: Hono<AppEnv>, store: Store, webhooks: WebhookDispatcher, baseUrl: string, tokenMap?: TokenMap): void {
    const ctx: RouteContext = { app, store, webhooks, baseUrl, tokenMap };
    // Static and prefixed paths first; the S3 front door last, because its
    // routes use a wildcard key param.
    inspectorRoutes(ctx);
    controlRoutes(ctx);
    d1Routes(ctx);
    r2RestRoutes(ctx);
    r2S3Routes(ctx);
  },
  seed(store: Store, baseUrl: string): void {
    seedDefaults(store, baseUrl);
  },
};

export default cloudflarePlugin;

export { stopCloudflareEngine as stopCloudflareServices };
