# @emulators/cloudflare

Cloudflare D1 and R2 emulation for [emulate](https://emulate.dev), backed by Miniflare (workerd).

```bash
npx emulate --service cloudflare
```

Point wrangler at it with one environment variable:

```bash
export CLOUDFLARE_API_BASE_URL="http://localhost:4000/client/v4"
export CLOUDFLARE_ACCOUNT_ID="0000000000000000000000000000000000"
export CLOUDFLARE_API_TOKEN="dev-cloudflare-token"

wrangler d1 create my-app
wrangler d1 migrations apply DB --remote
wrangler d1 execute DB --remote --command "SELECT 1"
wrangler r2 bucket create my-uploads
```

S3 clients point at the S3-compatible front door:

```ts
new S3Client({
  region: "auto",
  endpoint: "http://localhost:4000/cdn-cgi/local/r2/s3",
  forcePathStyle: true,
  credentials: { accessKeyId, secretAccessKey },
});
```

## Why Miniflare

Miniflare's D1 is not an imitation of D1's storage engine, it is that engine: a Durable Object over workerd's SQLite, which is what production D1 runs on. So the behaviour that bites in production shows up here.

The clearest example is a drizzle-kit table rebuild. drizzle-kit wraps a `__new_<table>` create/copy/drop/rename in `PRAGMA foreign_keys=OFF` / `=ON`. In D1 that pragma is accepted with no error and is a silent no-op, because workerd's SQLite always holds an open write transaction and SQLite treats the pragma as a no-op inside one. `DROP TABLE parent` therefore runs with foreign keys still enforced, `ON DELETE CASCADE` removes every child row, and the migration reports success. `src/__tests__/d1-quirks.test.ts` pins exactly that.

A `node:sqlite` backend would honour the pragma and report the same migration as safe. That is worse than having no emulator at all.

## Fault injection and the oracle

Everything lives under `/_cloudfault`; `GET /_cloudfault` documents it.

```
POST   /_cloudfault/plan            { perturbations, allowContractProbes? } -> 204
DELETE /_cloudfault/plan            -> 204
GET    /_cloudfault/plan            -> { perturbations }
GET    /_cloudfault/events          -> { activations }
POST   /_cloudfault/reset           -> 204

GET    /_cloudfault/outcome/:token  -> PrivilegedOutcome | 404
GET    /_cloudfault/version/:resource
GET    /_cloudfault/snapshot
```

Send `x-emulate-operation: <your token>` on a request and ask the oracle about it afterwards. The token is caller-minted on purpose: under `commit-then-response-lost` the response is destroyed, so a token read off the response could never be used to ask about the only request worth asking about.

See the [docs](https://emulate.dev/docs/cloudflare) for the full surface.
