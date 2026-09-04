---
name: cloudflare
description: Emulated Cloudflare D1 (SQL) and R2 (object storage) for local development and testing. Use when the user needs to run wrangler d1 or wrangler r2 commands without a Cloudflare account, apply D1 migrations locally against a remote-shaped API, test D1 SQL behavior including its migration quirks, emulate R2 buckets and objects over the S3 API, or inject faults and ask what actually committed. Triggers include "Cloudflare emulator", "emulate D1", "local D1", "D1 migrations without an account", "mock R2", "local R2", "wrangler d1 create locally", "CLOUDFLARE_API_BASE_URL", or any task requiring local Cloudflare D1/R2 emulation.
allowed-tools: Bash(npx emulate:*), Bash(emulate:*), Bash(npx wrangler:*), Bash(wrangler:*), Bash(curl:*)
---

# Cloudflare D1 and R2 Emulator

D1 and R2 emulation backed by Miniflare, which runs workerd's SQLite. That is the same engine production D1 runs on, so SQL behaves the way it behaves in production, quirks included.

D1 and R2 share one package because they share one account namespace, one response envelope, one Miniflare instance, and one `CLOUDFLARE_API_BASE_URL`. wrangler cannot be pointed at two origins.

## Start

```bash
# Cloudflare only
npx emulate --service cloudflare

# Default port (when run alone)
# http://localhost:4000
```

Or programmatically:

```typescript
import { createEmulator } from 'emulate'

const cf = await createEmulator({ service: 'cloudflare', port: 4007 })
// cf.url === 'http://localhost:4007'
```

## Pointing wrangler at the emulator

One environment variable redirects every `wrangler d1` and `wrangler r2` call. No proxy, no hosts file.

```bash
export CLOUDFLARE_API_BASE_URL="http://localhost:4007/client/v4"
export CLOUDFLARE_ACCOUNT_ID="0000000000000000000000000000000000"
export CLOUDFLARE_API_TOKEN="dev-cloudflare-token"
```

With that set:

```bash
wrangler d1 create my-app
wrangler d1 list
wrangler d1 info DB
wrangler d1 migrations list DB --remote
wrangler d1 migrations apply DB --remote
wrangler d1 execute DB --remote --command "SELECT name FROM sqlite_master WHERE type='table'"

wrangler r2 bucket create my-uploads
wrangler r2 bucket list
wrangler r2 object put my-uploads/notes/hello.txt --file hello.txt --remote
wrangler r2 object get my-uploads/notes/hello.txt --remote --pipe
```

Copy the `database_id` wrangler prints into `wrangler.jsonc`, or set it in the seed config so it is stable across restarts.

## Pointing an S3 client at R2

The S3 front door is mounted at `/cdn-cgi/local/r2/s3` and the path is part of the endpoint. SigV4 signs the request path, so the prefix cannot be dropped. Signatures are really verified.

```typescript
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'

const s3 = new S3Client({
  region: 'auto',
  endpoint: 'http://localhost:4007/cdn-cgi/local/r2/s3',
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
})

await s3.send(new PutObjectCommand({ Bucket: 'my-uploads', Key: 'img/logo.png', Body: bytes }))
```

Objects written through the S3 API and through `wrangler r2 object put` are the same objects.

## Seed Config

```yaml
cloudflare:
  port: 4007
  account_id: "0000000000000000000000000000000000"
  api_token: dev-cloudflare-token
  # Omit to keep everything in memory for the life of the process.
  persist_dir: .emulate/cloudflare
  d1:
    databases:
      - name: app_dev
        # Optional. Generated when omitted; set it to keep the id stable.
        id: 11111111-1111-4111-8111-111111111111
  r2:
    buckets:
      - name: app-uploads
        # Generated when omitted and written to --generated-secrets-file.
        s3_access_key_id: AKIAEMULATE
        s3_secret_access_key: emulate-secret
```

`port` is the ordinary HTTP port. D1 and R2 are HTTP only, so unlike postgres and redis there is no separate wire-protocol port.

Databases and buckets can also be created at runtime through the API; each becomes a new Miniflare binding on the running instance rather than a new process.

## API Endpoints

### D1

Every route is served both at `/client/v4/accounts/:accountId/...` and at the bare `/accounts/:accountId/...`.

- `POST /accounts/:accountId/d1/database` - create, body `{ name }`
- `GET /accounts/:accountId/d1/database` - list, `?page`, `?per_page`, `?name`
- `GET /accounts/:accountId/d1/database/:databaseId` - info, `?fields=`
- `PATCH` / `PUT /accounts/:accountId/d1/database/:databaseId` - `{ read_replication: { mode } }`
- `DELETE /accounts/:accountId/d1/database/:databaseId` - delete
- `POST /accounts/:accountId/d1/database/:databaseId/query` - `{ sql, params? }` or `{ batch: [...] }`, results as row objects
- `POST /accounts/:accountId/d1/database/:databaseId/raw` - same, results as `{ columns, rows }`

`:databaseId` accepts a uuid or a database name.

Not implemented, and answered with an explanatory `success: false` envelope: `/import`, `/export`, `/time_travel/*`.

```bash
BASE="http://localhost:4007/client/v4/accounts/0000000000000000000000000000000000/d1/database"

# Create a database
curl -X POST $BASE -H "Content-Type: application/json" -d '{"name":"app_dev"}'

# Run SQL (multiple statements run as one atomic batch)
curl -X POST $BASE/app_dev/query -H "Content-Type: application/json" \
  -d '{"sql":"CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO t (name) VALUES (?);","params":[]}'

# Bound parameters (single statement only, as with real D1)
curl -X POST $BASE/app_dev/query -H "Content-Type: application/json" \
  -d '{"sql":"INSERT INTO t (name) VALUES (?)","params":["hello"]}'
```

### R2

- `POST /accounts/:accountId/r2/buckets` - create, body `{ name, locationHint?, storageClass? }`
- `GET /accounts/:accountId/r2/buckets` - list, returns `result.buckets`
- `GET /accounts/:accountId/r2/buckets/:bucket` - info
- `DELETE /accounts/:accountId/r2/buckets/:bucket` - delete
- `PUT` / `GET` / `DELETE /accounts/:accountId/r2/buckets/:bucket/objects/:key` - object CRUD, keys may contain `/`

The S3-compatible API lives under `/cdn-cgi/local/r2/s3` and covers put, get, head, delete, list (prefix, delimiter, pagination), multipart upload, conditional headers, ranges and checksums.

### Inspector

`GET /_inspector` with tabs for D1, R2, Operations and Faults. The Operations tab is the oracle ledger.

## Fault Injection and the Oracle

`GET /_cloudfault` documents the whole surface at runtime.

```
POST   /_cloudfault/plan            { perturbations, allowContractProbes? } -> 204
DELETE /_cloudfault/plan            -> 204
GET    /_cloudfault/plan            -> { perturbations }
GET    /_cloudfault/events          -> { activations }
POST   /_cloudfault/reset           -> 204 (engine, ledger and plan)

GET    /_cloudfault/outcome/:token  -> PrivilegedOutcome | 404
GET    /_cloudfault/version/:res    -> { resource, version }
GET    /_cloudfault/snapshot        -> { databases, buckets, operations, versions }
```

A perturbation is a data record:

```json
{
  "id": "lost-1",
  "target": "app_dev",
  "kind": "commit-then-response-lost",
  "phase": "after-commit-before-response",
  "operation": "d1.query",
  "selector": { "occurrence": 2 },
  "maxActivations": 1,
  "metadata": { "hangMs": 0 }
}
```

Kinds: `commit-then-response-lost`, `commit-then-timeout`, `commit-then-disconnect`, `timeout-before-send`, `reject-before-commit`, `error-after-commit`, `rate-limit`, `malformed-response`, `latency`, `signature-rejected`, `r2-conditional-race`, and the contract probes `partial-batch-application`, `migration-partial-then-fail`, `r2-list-after-put-stale`.

Contract probes model nothing Cloudflare does: real D1 batches are atomic and real R2 list is strongly consistent. They exist to discover undocumented reliance on those guarantees, and the plan is refused unless it sets `"allowContractProbes": true`.

### Asking what actually happened

Mint the token yourself and send it on the request. Under `commit-then-response-lost` there is no response to read a correlation header from, which is exactly why the token has to come from the caller.

```bash
curl -X POST http://localhost:4007/_cloudfault/plan -H "Content-Type: application/json" -d '{
  "perturbations": [{
    "id": "lost-1", "target": "*", "kind": "commit-then-response-lost",
    "phase": "after-commit-before-response", "operation": "d1.query"
  }]
}'

# The connection is destroyed. curl exits 52, "Empty reply from server".
curl -X POST "$BASE/app_dev/query" \
  -H "Content-Type: application/json" \
  -H "x-emulate-operation: demo-1" \
  -d '{"sql":"INSERT INTO t (name) VALUES (\"lost\")"}'

# But the emulator knows.
curl http://localhost:4007/_cloudfault/outcome/demo-1
# { "actual": "committed", "observed": "indeterminate",
#   "version": 3, "applied": [{"index":0,"committed":true}],
#   "evidence": { "changes": 1, "rows_written": 1, ... },
#   "fault": { "id": "lost-1", "kind": "commit-then-response-lost" } }
```

An unknown token answers 404. It never guesses "committed", so a caller that cannot get an answer must record the outcome as unknown.

## The migration quirk worth knowing

drizzle-kit rebuilds a table by creating `__new_<table>`, copying rows, dropping the original and renaming, wrapped in `PRAGMA foreign_keys=OFF` / `=ON`. In D1 that pragma is silently ignored, so the `DROP TABLE` cascade-deletes every child row, and the migration still reports success.

The emulator reproduces this, because Miniflare is the same SQLite. Apply migrations against it and assert row counts in every table with an incoming `ON DELETE CASCADE` foreign key, and the bug surfaces in CI instead of in production.

## Known limitation: drizzle-kit

`drizzle-kit`'s `d1-http` driver hardcodes `https://api.cloudflare.com` at both of its call sites and reads no base-URL override from config or the environment. `drizzle-kit push`, `migrate`, `studio` and `introspect` therefore cannot be pointed at the emulator.

Use `drizzle-kit generate` (offline, no network) and apply with `wrangler d1 migrations apply`, which works against the emulator. That is also the migration path Cloudflare recommends.
