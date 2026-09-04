import type { Context, RouteContext } from "@emulators/core";
import { getEngine } from "../engine.js";
import { getCloudflareStore } from "../store.js";
import { getFaultPlan, metaNumber } from "../faults.js";
import { Oracle, OPERATION_TOKEN_HEADER } from "../oracle.js";
import { resolveToken, sleep, destroyedResponse } from "../helpers.js";

/**
 * The S3-compatible front door.
 *
 * Miniflare ships a real SigV4 S3 server for any bucket configured with
 * `s3Credentials`, mounted at `/cdn-cgi/local/r2/s3`. It is undocumented but
 * present in both v4 and v5, and it brings multipart, conditional headers,
 * five checksum algorithms, cursor pagination and delimiter/CommonPrefixes with
 * it. Writing that by hand is months of work, so the emulator proxies to it.
 *
 * The proxy is deliberately PATH-PRESERVING. SigV4 signs the request path, so
 * a proxy that remounted the endpoint at the origin root would invalidate every
 * signature (verified: rewriting `/bkt/key` to `/cdn-cgi/local/r2/s3/bkt/key`
 * fails with SignatureDoesNotMatch). Clients therefore point at
 * `http://localhost:<port>/cdn-cgi/local/r2/s3` with `forcePathStyle: true`.
 *
 * The `Host` header is also signed, and it is emulate's host rather than
 * Miniflare's. Miniflare's entry worker has a hook for exactly this:
 * `MF-Original-Hostname` replaces the host used for verification.
 */

const S3_PREFIX = "/cdn-cgi/local/r2/s3";

/** Stripped from the request before it is forwarded; the fetch layer resets them. */
const REQUEST_HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "content-encoding",
  "host",
]);

/**
 * Stripped from the response. `content-length` is deliberately NOT in this set:
 * a HEAD reply carries no body, and dropping its length is what makes an S3
 * client report ContentLength as undefined.
 */
const RESPONSE_HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "content-encoding"]);

/** Statuses whose Response constructor refuses any body, an empty one included. */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

const MUTATING = new Set(["PUT", "POST", "DELETE", "PATCH"]);

function operationFor(method: string, path: string): { operation: string; bucket: string } {
  const rest = path.slice(S3_PREFIX.length).replace(/^\//, "");
  const [bucket = ""] = rest.split("/");
  const verb = method === "GET" ? "get" : method === "HEAD" ? "head" : method === "PUT" ? "put" : method.toLowerCase();
  return { operation: `r2.s3.${verb}`, bucket };
}

/**
 * Miniflare only mounts its S3 service for buckets configured with credentials,
 * so every known bucket has to be registered before a request is proxied. The
 * call is idempotent and cheap once the desired state already matches.
 */
async function ensureBucketsRegistered(ctx: RouteContext): Promise<void> {
  const engine = getEngine();
  for (const row of getCloudflareStore(ctx.store).buckets.all()) {
    await engine.addR2Bucket(row.binding, row.name, {
      accessKeyId: row.s3_access_key_id,
      secretAccessKey: row.s3_secret_access_key,
    });
  }
}

async function proxy(c: Context, ctx: RouteContext, oracle: Oracle): Promise<Response> {
  const url = new URL(c.req.url);
  const { operation, bucket } = operationFor(c.req.method, url.pathname);
  const resource = `r2:${bucket}`;
  const token = resolveToken(c);
  const plan = getFaultPlan();
  const op = { target: bucket, operation, resource };
  const { executionIndex, occurrence } = plan.begin(op);
  const faultCtx = { executionIndex, occurrence, token };
  oracle.begin({ token, service: "r2", operation, resource, method: c.req.method, path: url.pathname });
  c.header(OPERATION_TOKEN_HEADER, token);

  const pre = plan.take(op, "before-send", faultCtx) ?? plan.take(op, "before-commit", faultCtx);
  if (pre) {
    if (pre.kind === "latency") {
      await sleep(metaNumber(pre, "delayMs", 250));
    } else if (pre.kind === "signature-rejected") {
      oracle.record(token, {
        actual: "not-committed",
        observed: "definite-failure",
        fault: { id: pre.id, kind: pre.kind },
      });
      return c.body(
        '<?xml version="1.0" encoding="UTF-8"?><Error><Code>SignatureDoesNotMatch</Code><Message>The request signature we calculated does not match the signature you provided.</Message></Error>',
        403,
        { "Content-Type": "application/xml" },
      );
    } else if (pre.kind === "rate-limit") {
      oracle.record(token, {
        actual: "not-committed",
        observed: "definite-failure",
        fault: { id: pre.id, kind: pre.kind },
      });
      return c.body(
        '<?xml version="1.0" encoding="UTF-8"?><Error><Code>TooManyRequests</Code><Message>Please reduce your request rate.</Message></Error>',
        429,
        { "Content-Type": "application/xml", "Retry-After": String(metaNumber(pre, "retryAfterSeconds", 1)) },
      );
    } else if (pre.kind === "r2-conditional-race") {
      oracle.record(token, {
        actual: "not-committed",
        observed: "definite-failure",
        evidence: { expectedEtag: c.req.header("if-match") ?? null },
        fault: { id: pre.id, kind: pre.kind },
      });
      return c.body(
        '<?xml version="1.0" encoding="UTF-8"?><Error><Code>PreconditionFailed</Code><Message>At least one of the pre-conditions you specified did not hold.</Message></Error>',
        412,
        { "Content-Type": "application/xml" },
      );
    } else {
      oracle.record(token, {
        actual: "not-committed",
        observed: "definite-failure",
        fault: { id: pre.id, kind: pre.kind },
      });
      return c.body(
        '<?xml version="1.0" encoding="UTF-8"?><Error><Code>InternalError</Code><Message>We encountered an internal error. Please try again.</Message></Error>',
        metaNumber(pre, "status", 500),
        { "Content-Type": "application/xml" },
      );
    }
  }

  const post = pre
    ? undefined
    : (plan.take(op, "after-commit-before-response", faultCtx) ?? plan.take(op, "during-response", faultCtx));

  await ensureBucketsRegistered(ctx);
  const origin = await getEngine().origin();
  const target = new URL(url.pathname + url.search, origin);
  const headers = new Headers();
  c.req.raw.headers.forEach((value, key) => {
    if (!REQUEST_HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value);
  });
  // Restores the host the client signed against.
  headers.set("MF-Original-Hostname", c.req.header("host") ?? url.host);

  const method = c.req.method;
  const body = method === "GET" || method === "HEAD" ? undefined : await c.req.arrayBuffer();
  const upstream = await fetch(target, { method, headers, body });
  const payload = await upstream.arrayBuffer();

  const mutation = MUTATING.has(method);
  const committed = mutation && upstream.ok;
  const version = committed ? oracle.bumpVersion(resource) : oracle.versionOf(resource);
  const evidence = { upstreamStatus: upstream.status, etag: upstream.headers.get("etag") };

  const outHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!RESPONSE_HOP_BY_HOP.has(key.toLowerCase())) outHeaders.set(key, value);
  });
  outHeaders.set(OPERATION_TOKEN_HEADER, token);

  if (
    post &&
    (post.kind === "commit-then-response-lost" ||
      post.kind === "commit-then-timeout" ||
      post.kind === "commit-then-disconnect")
  ) {
    oracle.record(token, {
      actual: committed ? "committed" : "unknown",
      observed: "indeterminate",
      version: version ?? undefined,
      applied: [{ index: 0, committed }],
      evidence,
      fault: { id: post.id, kind: post.kind },
    });
    await sleep(metaNumber(post, "hangMs", 0));
    return destroyedResponse();
  }

  if (post && post.kind === "error-after-commit") {
    oracle.record(token, {
      actual: committed ? "committed" : "unknown",
      observed: "definite-failure",
      version: version ?? undefined,
      applied: [{ index: 0, committed }],
      evidence,
      fault: { id: post.id, kind: post.kind },
    });
    return c.body(
      '<?xml version="1.0" encoding="UTF-8"?><Error><Code>InternalError</Code><Message>We encountered an internal error. Please try again.</Message></Error>',
      500,
      { "Content-Type": "application/xml" },
    );
  }

  oracle.record(token, {
    actual: committed ? "committed" : mutation ? "not-committed" : "unknown",
    observed: upstream.ok ? "success" : "definite-failure",
    version: version ?? undefined,
    applied: [{ index: 0, committed }],
    evidence,
  });

  const emptyBody = method === "HEAD" || NULL_BODY_STATUSES.has(upstream.status);
  return new Response(emptyBody ? null : payload, { status: upstream.status, headers: outHeaders });
}

export function r2S3Routes(ctx: RouteContext): void {
  const { app } = ctx;
  const oracle = new Oracle(ctx.store);
  for (const method of ["GET", "PUT", "POST", "DELETE", "HEAD"]) {
    app.on(method, S3_PREFIX, (c) => proxy(c, ctx, oracle));
    app.on(method, `${S3_PREFIX}/:rest{.+}`, (c) => proxy(c, ctx, oracle));
  }
}

export const S3_ENDPOINT_PATH = S3_PREFIX;
