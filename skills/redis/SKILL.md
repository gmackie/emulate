---
name: redis
description: Emulated Redis speaking the real Redis wire protocol, for local development and testing. Use when the user needs Redis locally without Docker or a system install, wants to point redis-cli or a Redis client at a throwaway instance, needs a cache or rate limiter backend in CI, or wants to inspect emulated Redis state from a browser. Triggers include "Redis emulator", "emulate redis", "local redis", "redis without Docker", "redis-memory-server", "REDIS_URL for tests", or any task requiring a local Redis.
allowed-tools: Bash(npx emulate:*), Bash(emulate:*), Bash(redis-cli:*), Bash(curl:*)
---

# Redis Emulator

A real Redis server managed by [redis-memory-server](https://www.npmjs.com/package/redis-memory-server). Any Redis client connects to it unchanged, because it is Redis.

## Two ports, not one

This service listens on two ports, and mixing them up is the most common mistake:

- The **wire protocol** port, `6379` by default, is what `redis-cli` and every Redis client connect to. It is set by `port` in the seed config.
- The **HTTP admin and inspector** port is the ordinary emulate port, `basePort + index`. It serves `/status`, `/reset`, `/flush` and the inspector.

The banner prints both:

```
  redis  http://localhost:4015  (wire: localhost:6379)
```

## Binary requirement

`redis-memory-server` downloads or builds a real Redis binary on first use. On a machine where that build fails (an old GNU make, no toolchain), point it at an installed Redis instead:

```bash
export REDISMS_SYSTEM_BINARY=/opt/homebrew/bin/redis-server
npx emulate --service redis
```

## Start

The wire server is started from the seed config, so redis needs a config file. Without one the HTTP admin app still starts, but nothing listens on 6379.

```yaml
# emulate.config.yaml
redis:
  port: 6379
```

```bash
npx emulate --service redis
```

## Connecting

```bash
redis-cli -p 6379 ping
```

```bash
REDIS_URL="redis://localhost:6379"
```

Any client works: `ioredis`, `redis`, `@upstash/redis` with a local endpoint, BullMQ.

## Seed Config

```yaml
redis:
  # Wire protocol port. NOT the HTTP admin port.
  port: 6379
  binary:
    # Pin the Redis version redis-memory-server fetches.
    version: "7.2.4"
```

Redis data lives in the Redis process, outside emulate's store snapshot, so it is not covered by the programmatic API's persistence adapter.

## HTTP Admin API

On the HTTP port, not the wire port.

```bash
BASE="http://localhost:4015"

# Server status, wire host and port, engine version
curl $BASE/status
```

`POST /reset` and `POST /flush` answer 501 on purpose: flushing is a Redis operation and belongs to a Redis client.

```bash
redis-cli -p 6379 FLUSHALL
```

## Inspector

The inspector is served from the root of the HTTP port.

- `GET /` - status, engine version, wire protocol address
- `GET /keys` - keys held by the emulated instance

## Shutdown

The Redis server is a child process that outlives the HTTP listener, so the CLI stops it explicitly on SIGINT and SIGTERM. Killing the process without a signal handler can leave it running.
