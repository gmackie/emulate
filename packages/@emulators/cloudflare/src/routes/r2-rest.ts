import type { Context, RouteContext } from "@emulators/core";
import { cfOk, R2_CODES } from "../envelope.js";
import { getCloudflareStore } from "../store.js";
import type { R2BucketRow } from "../entities.js";
import { getEngine, bindingNameFor, type S3Credentials } from "../engine.js";
import { Oracle } from "../oracle.js";
import { metaNumber } from "../faults.js";
import {
  API_PREFIX,
  applyPreFault,
  beginAttempt,
  destroyedResponse,
  failEnvelope,
  jsonEnvelope,
  readJsonBody,
  sleep,
} from "../helpers.js";

const BUCKET_NAME = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

function describeBucket(row: R2BucketRow): Record<string, unknown> {
  return {
    name: row.name,
    creation_date: row.created_at,
    location: row.location,
    storage_class: row.storage_class,
    jurisdiction: row.jurisdiction,
  };
}

function findBucket(ctx: RouteContext, name: string): R2BucketRow | undefined {
  return getCloudflareStore(ctx.store).buckets.findOneBy("name", name);
}

export interface CreateBucketInput {
  name: string;
  location?: string;
  storageClass?: string;
  jurisdiction?: string;
  credentials?: S3Credentials;
}

export function createBucketRow(ctx: RouteContext, input: CreateBucketInput): R2BucketRow {
  const { buckets } = getCloudflareStore(ctx.store);
  return buckets.insert({
    name: input.name,
    binding: bindingNameFor("R2", input.name),
    location: input.location ?? "enam",
    storage_class: input.storageClass ?? "Standard",
    jurisdiction: input.jurisdiction ?? "default",
    s3_access_key_id: input.credentials?.accessKeyId ?? "",
    s3_secret_access_key: input.credentials?.secretAccessKey ?? "",
  });
}

async function registerBucket(row: R2BucketRow): Promise<void> {
  await getEngine().addR2Bucket(row.binding, row.name, {
    accessKeyId: row.s3_access_key_id,
    secretAccessKey: row.s3_secret_access_key,
  });
}

export { registerBucket };

async function handleObject(
  c: Context,
  ctx: RouteContext,
  oracle: Oracle,
  verb: "get" | "put" | "delete",
): Promise<Response> {
  const row = findBucket(ctx, c.req.param("bucketName"));
  if (!row) return failEnvelope(c, R2_CODES.NO_SUCH_BUCKET, "The specified bucket does not exist.", 404);
  const key = c.req.param("objectName");
  const resource = `r2:${row.name}`;
  const mutation = verb !== "get";
  const attempt = beginAttempt(c, { target: row.name, operation: `r2.object.${verb}`, resource }, oracle, "r2");

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

  // Idempotent registration on the request path, for the same reason D1 does
  // it: the eager engine start is fire-and-forget.
  await registerBucket(row);
  const bucket = await getEngine().getR2(row.binding);

  if (verb === "get") {
    const object = await bucket.get(key);
    if (!object) return failEnvelope(c, R2_CODES.NO_SUCH_KEY, "The specified key does not exist.", 404);
    const body = await object.arrayBuffer();
    oracle.record(attempt.token, {
      actual: "unknown",
      observed: "success",
      evidence: { etag: object.etag, size: object.size },
    });
    return c.body(body, 200, {
      "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
      ETag: `"${object.etag}"`,
      "Content-Length": String(object.size),
    });
  }

  let evidence: Record<string, unknown>;
  if (verb === "put") {
    const payload = await c.req.arrayBuffer();
    const contentType = c.req.header("Content-Type") ?? "application/octet-stream";
    const written = await bucket.put(key, payload, { httpMetadata: { contentType } });
    evidence = { etag: written?.etag, size: written?.size ?? payload.byteLength };
  } else {
    await bucket.delete(key);
    evidence = { deleted: key };
  }

  const version = oracle.bumpVersion(resource);
  const post = attempt.post;
  const applied = [{ index: 0, committed: true }];

  if (!post) {
    oracle.record(attempt.token, { actual: "committed", observed: "success", version, applied, evidence });
    return jsonEnvelope(c, cfOk(verb === "put" ? evidence : null));
  }

  switch (post.kind) {
    case "commit-then-response-lost":
    case "commit-then-timeout":
    case "commit-then-disconnect":
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
    case "error-after-commit":
      oracle.record(attempt.token, {
        actual: "committed",
        observed: "definite-failure",
        version,
        applied,
        evidence,
        fault: { id: post.id, kind: post.kind },
      });
      return failEnvelope(c, R2_CODES.TOO_MANY_REQUESTS, "Internal error. Please retry.", 500);
    default:
      oracle.record(attempt.token, {
        actual: mutation ? "committed" : "unknown",
        observed: "success",
        version,
        applied,
        evidence,
      });
      return jsonEnvelope(c, cfOk(verb === "put" ? evidence : null));
  }
}

export function r2RestRoutes(ctx: RouteContext): void {
  const { app } = ctx;
  const oracle = new Oracle(ctx.store);
  const { buckets } = getCloudflareStore(ctx.store);

  const base = `${API_PREFIX}/accounts/:accountId/r2/buckets`;

  app.get(`${base}/:bucketName/objects/:objectName{.+}`, (c) => handleObject(c, ctx, oracle, "get"));
  app.put(`${base}/:bucketName/objects/:objectName{.+}`, (c) => handleObject(c, ctx, oracle, "put"));
  app.delete(`${base}/:bucketName/objects/:objectName{.+}`, (c) => handleObject(c, ctx, oracle, "delete"));

  app.get(`${base}/:bucketName`, (c) => {
    const row = findBucket(ctx, c.req.param("bucketName"));
    if (!row) return failEnvelope(c, R2_CODES.NO_SUCH_BUCKET, "The specified bucket does not exist.", 404);
    return jsonEnvelope(c, cfOk(describeBucket(row)));
  });

  app.delete(`${base}/:bucketName`, async (c) => {
    const row = findBucket(ctx, c.req.param("bucketName"));
    if (!row) return failEnvelope(c, R2_CODES.NO_SUCH_BUCKET, "The specified bucket does not exist.", 404);
    await getEngine().removeR2Bucket(row.binding);
    buckets.delete(row.id);
    return jsonEnvelope(c, cfOk(null));
  });

  app.post(base, async (c) => {
    const body = await readJsonBody(c);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!BUCKET_NAME.test(name)) {
      return failEnvelope(
        c,
        R2_CODES.INVALID_BUCKET_NAME,
        "The specified bucket name is not valid. Bucket names must be 3-63 lowercase alphanumeric characters or hyphens.",
        400,
      );
    }
    if (findBucket(ctx, name)) {
      // Real R2 answers a duplicate create with HTTP 400, not 409.
      return failEnvelope(c, R2_CODES.BUCKET_ALREADY_EXISTS, "The bucket you tried to create already exists.", 400);
    }
    const row = createBucketRow(ctx, {
      name,
      location: typeof body.locationHint === "string" ? body.locationHint : undefined,
      storageClass: typeof body.storageClass === "string" ? body.storageClass : undefined,
      jurisdiction: c.req.header("cf-r2-jurisdiction") ?? undefined,
      credentials: defaultCredentialsFor(ctx, name),
    });
    await registerBucket(row);
    return jsonEnvelope(c, cfOk(describeBucket(row)));
  });

  app.get(base, (c) => {
    // wrangler reads `result.buckets` and sends no pagination params.
    const rows = buckets.all().map(describeBucket);
    return jsonEnvelope(c, {
      success: true,
      errors: [],
      messages: [],
      result: { buckets: rows },
      result_info: { page: 1, per_page: rows.length, count: rows.length, total_count: rows.length, total_pages: 1 },
    });
  });
}

/**
 * A bucket created at runtime still needs S3 credentials, because Miniflare's
 * S3 front door only exists for buckets configured with them. They are derived
 * from the account-wide pair the seed config generated so one client config
 * reaches every bucket.
 */
function defaultCredentialsFor(ctx: RouteContext, _name: string): S3Credentials | undefined {
  const existing = getCloudflareStore(ctx.store).buckets.all()[0];
  if (existing?.s3_access_key_id) {
    return { accessKeyId: existing.s3_access_key_id, secretAccessKey: existing.s3_secret_access_key };
  }
  const fallback = ctx.store.getData<S3Credentials>("cloudflare.s3_credentials");
  return fallback;
}
