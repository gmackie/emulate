---
name: postgres
description: Emulated PostgreSQL (PGlite/WASM) speaking the real Postgres wire protocol, for local development and testing. Use when the user needs a Postgres database locally without Docker or a system install, wants to point psql or a Postgres driver at a throwaway database, needs to run migrations or seed data against Postgres in CI, or wants to inspect and query an emulated database from a browser. Triggers include "Postgres emulator", "emulate postgres", "local postgres", "postgres without Docker", "PGlite", "DATABASE_URL for tests", or any task requiring a local Postgres.
allowed-tools: Bash(npx emulate:*), Bash(emulate:*), Bash(psql:*), Bash(curl:*)
---

# PostgreSQL Emulator

Postgres 17.4 compiled to WASM via [PGlite](https://pglite.dev), fronted by `PGLiteSocketServer` so it speaks the real Postgres wire protocol. Any Postgres client or driver connects to it unchanged.

## Two ports, not one

This service listens on two ports, and mixing them up is the most common mistake:

- The **wire protocol** port, `5432` by default, is what `psql` and every Postgres driver connect to. It is set by `port` in the seed config.
- The **HTTP admin and inspector** port is the ordinary emulate port, `basePort + index`. It serves `/status`, `/reset`, `/databases` and the inspector.

The banner prints both:

```
  postgres  http://localhost:4014  (wire: localhost:5432)
```

## Start

The wire server is started from the seed config, so postgres needs a config file. Without one the HTTP admin app still starts, but nothing listens on 5432.

```yaml
# emulate.config.yaml
postgres:
  port: 5432
  data_dir: ./data/pglite
  databases:
    - name: app_dev
      extensions: [uuid-ossp]
```

```bash
npx emulate --service postgres
```

`data_dir` is a directory PGlite creates its data in. Its parent must already exist: PGlite's mkdir is not recursive, so `./data/pglite` requires `./data` to be there first.

## Connecting

```bash
psql postgresql://postgres@localhost:5432/postgres
```

```bash
DATABASE_URL="postgresql://postgres@localhost:5432/postgres"
```

Any driver works: `pg`, `postgres`, Drizzle, Prisma, TypeORM.

Note that `psql` can appear to hang against PGlite on some connection paths. If you are only probing liveness, a driver such as `postgres-js` is a more reliable check than `psql`.

## Seed Config

```yaml
postgres:
  # Wire protocol port. NOT the HTTP admin port.
  port: 5432
  # PGlite data directory. The parent directory must exist.
  data_dir: ./data/pglite
  databases:
    - name: app_dev
      extensions:
        - uuid-ossp
        - pgcrypto
```

`databases` entries are recorded as metadata and their `extensions` are created with `CREATE EXTENSION IF NOT EXISTS`. PGlite serves a single database instance; the entries describe it rather than creating separate databases.

The data lives in `data_dir`, outside emulate's store snapshot, so it is not covered by the programmatic API's persistence adapter.

## HTTP Admin API

On the HTTP port, not the wire port.

```bash
BASE="http://localhost:4014"

# Engine status and known databases
curl $BASE/status

# Drop every table in the public schema
curl -X POST $BASE/reset

# Database metadata
curl $BASE/databases
```

## Inspector

The inspector is served from the root of the HTTP port.

- `GET /` - status, engine version, wire protocol address, database list
- `GET /tables` - tables with row counts
- `GET /query` - run a query from the browser, `POST /query` executes it

## Shutdown

The wire server is a raw TCP socket that outlives the HTTP listener, so the CLI stops it explicitly on SIGINT and SIGTERM. Killing the process without a signal handler can leave the port bound.
