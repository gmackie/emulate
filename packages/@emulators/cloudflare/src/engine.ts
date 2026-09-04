import type { Miniflare, MiniflareOptions } from "miniflare";
import { debug } from "@emulators/core";

export type D1Database = Awaited<ReturnType<Miniflare["getD1Database"]>>;

export interface R2ObjectLike {
  key: string;
  etag: string;
  size: number;
  uploaded: Date;
  httpMetadata?: { contentType?: string };
}

export interface R2ObjectBodyLike extends R2ObjectLike {
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * Miniflare's `ReplaceWorkersTypes<R2Bucket>` collapses to its `Request` type
 * under `tsc`, so the bucket is described structurally instead. Only the
 * methods the REST routes call are declared; the S3 front door does not go
 * through this at all, it proxies to workerd.
 */
export interface R2BucketLike {
  get(key: string): Promise<R2ObjectBodyLike | null>;
  head(key: string): Promise<R2ObjectLike | null>;
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string | null,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<R2ObjectLike | null>;
  delete(key: string | string[]): Promise<void>;
  list(options?: {
    prefix?: string;
    delimiter?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ objects: R2ObjectLike[]; truncated: boolean; cursor?: string; delimitedPrefixes: string[] }>;
}

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface EngineOptions {
  /** Root for Miniflare's own d1Persist/r2Persist directories. */
  persistDir?: string;
}

interface DesiredState {
  d1: Map<string, string>;
  r2: Map<string, { id: string; s3Credentials: S3Credentials }>;
}

/**
 * D1 and R2 are backed by one long-lived Miniflare instance for the life of the
 * emulate process.
 *
 * Miniflare is not emulating D1's storage engine, it IS D1's storage engine: a
 * `D1DatabaseObject` Durable Object over workerd's SQLite, the same engine
 * production D1 runs on. That is why the quirks fall out for free instead of
 * having to be imitated, and why `node:sqlite` is not an option here (it
 * honours `PRAGMA foreign_keys=OFF`, which D1 silently ignores, so it would
 * report a drizzle-kit table rebuild as safe when production destroys the
 * child rows).
 *
 * One instance, not one per database: importing miniflare costs over a second
 * and each instance another ~100 ms. Multiple D1 databases and R2 buckets
 * coexist in a single instance, and `setOptions()` adds bindings at runtime, so
 * `wrangler d1 create` is "add a binding to the running instance" rather than
 * "spawn a new workerd".
 */
class Engine {
  #mf: Miniflare | undefined;
  #ready: Promise<Miniflare> | undefined;
  #origin: string | undefined;
  #options: EngineOptions = {};
  readonly #desired: DesiredState = { d1: new Map(), r2: new Map() };

  configure(options: EngineOptions): void {
    this.#options = { ...this.#options, ...options };
  }

  get started(): boolean {
    return this.#mf !== undefined;
  }

  #buildOptions(): MiniflareOptions {
    const persist = this.#options.persistDir;
    const r2Buckets: Record<string, { id: string; s3Credentials: S3Credentials }> = {};
    for (const [binding, value] of this.#desired.r2) r2Buckets[binding] = value;
    const d1Databases: Record<string, string> = {};
    for (const [binding, uuid] of this.#desired.d1) d1Databases[binding] = uuid;

    return {
      modules: true,
      // A worker is mandatory even though nothing dispatches to it: Miniflare
      // refuses to construct without one. This placeholder is never reached by
      // the emulator, which talks to D1/R2 through the proxy API and to the S3
      // front door through /cdn-cgi/local/r2/s3.
      script: "export default { fetch() { return new Response('emulate cloudflare engine'); } };",
      d1Databases,
      r2Buckets,
      ...(persist ? { d1Persist: `${persist}/d1`, r2Persist: `${persist}/r2` } : {}),
    } satisfies MiniflareOptions;
  }

  async ensure(): Promise<Miniflare> {
    if (this.#ready) return this.#ready;
    this.#ready = (async () => {
      const { Miniflare: MiniflareCtor } = await import("miniflare");
      const mf = new MiniflareCtor(this.#buildOptions());
      const url = await mf.ready;
      this.#mf = mf;
      this.#origin = url.origin;
      debug("cloudflare", "miniflare engine ready", { origin: url.origin });
      return mf;
    })();
    try {
      return await this.#ready;
    } catch (error) {
      this.#ready = undefined;
      throw error;
    }
  }

  // setOptions calls are serialized: two concurrent requests each adding a
  // binding would otherwise race, and the loser's binding would be dropped
  // from the options object the winner submitted.
  #applying: Promise<void> = Promise.resolve();

  async #applyOptions(): Promise<void> {
    const next = this.#applying.then(async () => {
      const mf = await this.ensure();
      await mf.setOptions(this.#buildOptions());
    });
    this.#applying = next.catch(() => undefined);
    return next;
  }

  async addD1Database(binding: string, uuid: string): Promise<void> {
    if (this.#desired.d1.get(binding) === uuid) {
      await this.ensure();
      return;
    }
    this.#desired.d1.set(binding, uuid);
    await this.#applyOptions();
  }

  async removeD1Database(binding: string): Promise<void> {
    if (!this.#desired.d1.delete(binding)) return;
    await this.#applyOptions();
  }

  async addR2Bucket(binding: string, id: string, s3Credentials: S3Credentials): Promise<void> {
    const existing = this.#desired.r2.get(binding);
    if (
      existing?.id === id &&
      existing.s3Credentials.accessKeyId === s3Credentials.accessKeyId &&
      existing.s3Credentials.secretAccessKey === s3Credentials.secretAccessKey
    ) {
      await this.ensure();
      return;
    }
    this.#desired.r2.set(binding, { id, s3Credentials });
    await this.#applyOptions();
  }

  async removeR2Bucket(binding: string): Promise<void> {
    if (!this.#desired.r2.delete(binding)) return;
    await this.#applyOptions();
  }

  async getD1(binding: string): Promise<D1Database> {
    const mf = await this.ensure();
    return mf.getD1Database(binding);
  }

  async getR2(binding: string): Promise<R2BucketLike> {
    const mf = await this.ensure();
    return (await mf.getR2Bucket(binding)) as unknown as R2BucketLike;
  }

  /**
   * Origin of Miniflare's own HTTP listener, where the S3 front door lives.
   *
   * Read fresh every time rather than cached: no port is pinned in the options,
   * so `setOptions` can rebind the listener and a cached origin goes stale the
   * first time a bucket or database is added at runtime.
   */
  async origin(): Promise<string> {
    const mf = await this.ensure();
    const url = await mf.ready;
    this.#origin = url.origin;
    return url.origin;
  }

  async dispose(): Promise<void> {
    const mf = this.#mf;
    this.#mf = undefined;
    this.#ready = undefined;
    this.#origin = undefined;
    this.#desired.d1.clear();
    this.#desired.r2.clear();
    if (mf) await mf.dispose();
  }
}

let engineOptions: EngineOptions = {};
let engine = new Engine();

export function getEngine(): Engine {
  return engine;
}

export function configureEngine(options: EngineOptions): void {
  engineOptions = { ...engineOptions, ...options };
  engine.configure(options);
}

export function ensureEngine(): Promise<Miniflare> {
  return engine.ensure();
}

/**
 * Stop the workerd child process. Called from the CLI's shutdown path; without
 * it, Ctrl-C leaks a workerd process.
 */
export async function stopCloudflareEngine(): Promise<void> {
  await engine.dispose();
}

/** Drop every binding and the workerd process, then start clean. */
export async function resetCloudflareEngine(): Promise<void> {
  await engine.dispose();
  engine = new Engine();
  engine.configure(engineOptions);
}

/** Miniflare binding names must be identifier-safe; ids and names are not. */
export function bindingNameFor(prefix: string, key: string): string {
  return `${prefix}_${key.replace(/[^A-Za-z0-9]/g, "_")}`;
}
