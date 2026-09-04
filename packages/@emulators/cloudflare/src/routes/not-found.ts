import type { Context, RouteContext } from "@emulators/core";
import { cfFailWith, CF_CODES, type CloudflareApiMessage } from "../envelope.js";
import { API_PREFIX } from "../helpers.js";

/**
 * Unknown REST paths, answered the way api.cloudflare.com answers them.
 *
 * The REST API is served only under `/client/v4`. Every other emulator route
 * (the inspector, the fault control plane, the S3 front door) lives outside
 * that prefix and is untouched by this module.
 *
 * Measured against the live API on 2026-09-04:
 *
 *   POST /accounts/abc/d1/database/def/query
 *     404 {"result":null,"success":false,"errors":[{"code":7003,"message":
 *          "Could not route to /accounts/abc/d1/database/def/query, perhaps
 *           your object identifier is invalid?"}],"messages":[]}
 *   GET /accounts
 *     404 {"success":false,"errors":[{"code":10404,"message":
 *          "No route for that URI"}],"messages":[],"result":null}
 *
 * Both the prefixed and the unprefixed form return the same envelope, so the
 * emulator cannot let a request through on a path the real API rejects. Without
 * these routes the framework's default handler would answer with emulate's
 * generic `{ message, documentation_url }` body, which is not a Cloudflare
 * envelope at all and which `success`-keyed clients (wrangler, drizzle-kit)
 * cannot read.
 *
 * ONE deliberate departure from the real API: when the path would have matched
 * a real route under `/client/v4`, a second entry is appended to `errors`
 * naming the missing prefix. It is an addition, never a substitution - the
 * status is still 404, `success` is still false, `result` is still null, and
 * `errors[0]` is still byte-for-byte the real API's error - so no client can
 * mistake it for success and any client reading `errors[0]` behaves exactly as
 * it would in production. Multi-entry `errors` arrays are a shape the real API
 * produces too. The trade buys the fix for the single most likely local
 * misconfiguration: a `CLOUDFLARE_API_BASE_URL` that omits `/client/v4`, whose
 * bare 7003 otherwise reads as "your database id is wrong" and sends the
 * developer hunting in the wrong place. Clients surface `errors`, not
 * `messages` - drizzle-kit's d1-http driver ignores the HTTP status entirely
 * and reports the errors array - so the hint goes where it will be read.
 */

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;

/** Paths that would have matched a registered REST route had the prefix been there. */
const UNPREFIXED_REST_SURFACE = /^\/accounts\/[^/]+\/(?:d1|r2)(?:\/|$)/;

/** The real API routes on an account id; `/accounts` alone fails with a different code. */
const ACCOUNT_SCOPED = new RegExp(`^(?:${API_PREFIX})?/accounts/[^/]+(?:/|$)`);

function apiNotFound(c: Context, baseUrl: string): Response {
  const path = c.req.path;
  const errors: CloudflareApiMessage[] = ACCOUNT_SCOPED.test(path)
    ? [
        {
          code: CF_CODES.NOT_ROUTABLE,
          message: `Could not route to ${path}, perhaps your object identifier is invalid?`,
        },
      ]
    : [{ code: CF_CODES.NO_ROUTE, message: "No route for that URI" }];

  if (UNPREFIXED_REST_SURFACE.test(path)) {
    errors.push({
      code: CF_CODES.NOT_ROUTABLE,
      message: `emulate: the Cloudflare REST API is served under ${API_PREFIX}, and so is the real one. This request omitted the prefix. Set CLOUDFLARE_API_BASE_URL to ${baseUrl}${API_PREFIX} and retry ${API_PREFIX}${path}.`,
      documentation_url: "https://emulate.dev/docs/cloudflare",
    });
  }

  return c.json(cfFailWith(errors), 404);
}

/**
 * Registered last, after every real route, because the router takes the first
 * pattern that matches in registration order.
 */
export function apiNotFoundRoutes(ctx: RouteContext): void {
  const { app, baseUrl } = ctx;
  const handler = (c: Context): Response => apiNotFound(c, baseUrl);

  for (const method of METHODS) {
    app.on(method, "/accounts", handler);
    app.on(method, "/accounts/:rest{.*}", handler);
    app.on(method, API_PREFIX, handler);
    app.on(method, `${API_PREFIX}/:rest{.*}`, handler);
  }
}
