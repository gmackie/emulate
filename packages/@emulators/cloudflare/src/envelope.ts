/**
 * The Cloudflare REST envelope.
 *
 * Both wrangler and drizzle-kit key off the JSON `success` field rather than
 * the HTTP status (drizzle-kit's d1-http driver never inspects `res.status` at
 * all), so every response on every path must carry this shape, always as JSON.
 */

export interface CloudflareApiMessage {
  code: number;
  message: string;
  documentation_url?: string;
}

export interface CloudflareResultInfo {
  page: number;
  per_page: number;
  count: number;
  total_count: number;
  total_pages: number;
}

export interface CloudflareEnvelope<T> {
  success: boolean;
  errors: CloudflareApiMessage[];
  messages: CloudflareApiMessage[];
  result: T;
  result_info?: CloudflareResultInfo;
}

/** D1 error codes wrangler and the Cloudflare SDK special-case. */
export const D1_CODES = {
  /** Generic D1 failure carrying the SQLite message. Returned with HTTP 400. */
  GENERIC: 7500,
  /** "A database with that name already exists" (wrangler renders this text). */
  NAME_EXISTS: 7502,
  /** "You have reached the maximum number of D1 databases for your account." */
  ACCOUNT_LIMIT: 7406,
  /** Database not found. */
  NOT_FOUND: 7404,
} as const;

/** R2 REST error codes. */
export const R2_CODES = {
  BUCKET_ALREADY_EXISTS: 10004,
  NO_SUCH_BUCKET: 10006,
  NO_SUCH_KEY: 10007,
  BUCKET_NOT_EMPTY: 10008,
  INVALID_BUCKET_NAME: 10005,
  TOO_MANY_REQUESTS: 10058,
} as const;

/** Generic Cloudflare API codes. */
export const CF_CODES = {
  AUTHENTICATION: 10000,
  NOT_IMPLEMENTED: 1000,
  RATE_LIMITED: 971,
  /**
   * "Could not route to <path>, perhaps your object identifier is invalid?"
   * What api.cloudflare.com answers, with HTTP 404, for an unknown path that
   * still names an account (measured against the live API).
   */
  NOT_ROUTABLE: 7003,
  /** "No route for that URI" - the live API's answer for any other unknown path. */
  NO_ROUTE: 10404,
} as const;

export function cfOk<T>(result: T, resultInfo?: CloudflareResultInfo): CloudflareEnvelope<T> {
  return resultInfo
    ? { success: true, errors: [], messages: [], result, result_info: resultInfo }
    : { success: true, errors: [], messages: [], result };
}

export function cfFail(code: number, message: string): CloudflareEnvelope<null> {
  return cfFailWith([{ code, message }]);
}

/** A failure carrying more than one error entry, which the real API also returns. */
export function cfFailWith(errors: CloudflareApiMessage[]): CloudflareEnvelope<null> {
  return { success: false, errors, messages: [], result: null };
}

export function paginate<T>(items: T[], page: number, perPage: number): { rows: T[]; info: CloudflareResultInfo } {
  const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  const safePerPage = Number.isFinite(perPage) && perPage > 0 ? Math.floor(perPage) : 10;
  const start = (safePage - 1) * safePerPage;
  const rows = items.slice(start, start + safePerPage);
  return {
    rows,
    info: {
      page: safePage,
      per_page: safePerPage,
      count: rows.length,
      total_count: items.length,
      total_pages: Math.max(1, Math.ceil(items.length / safePerPage)),
    },
  };
}
