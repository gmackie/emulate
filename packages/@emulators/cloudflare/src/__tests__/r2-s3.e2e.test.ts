import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, serve } from "@emulators/core";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { cloudflarePlugin, seedFromConfig, stopCloudflareEngine, resetFaultPlan, S3_ENDPOINT_PATH } from "../index.js";

/**
 * The S3 front door, driven by a real `@aws-sdk/client-s3` over a real socket.
 *
 * Signatures are genuinely verified: this proxies to Miniflare's SigV4 S3
 * server, so a wrong secret really fails. The endpoint carries the
 * `/cdn-cgi/local/r2/s3` path because SigV4 signs the path, and remounting it
 * at the origin root would invalidate every signature.
 */

const PORT = 4177;
const ACCESS_KEY_ID = "AKIAEMULATETEST";
const SECRET_ACCESS_KEY = "emulate-secret-key";

let server: ReturnType<typeof serve> | undefined;

function makeClient(secret = SECRET_ACCESS_KEY): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: `http://127.0.0.1:${PORT}${S3_ENDPOINT_PATH}`,
    forcePathStyle: true,
    credentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: secret },
  });
}

beforeAll(async () => {
  const app = createServer(cloudflarePlugin, { port: PORT, baseUrl: `http://127.0.0.1:${PORT}` });
  cloudflarePlugin.seed?.(app.store, app.baseUrl);
  seedFromConfig(app.store, app.baseUrl, {
    r2: {
      buckets: [{ name: "app-uploads", s3_access_key_id: ACCESS_KEY_ID, s3_secret_access_key: SECRET_ACCESS_KEY }],
    },
  });
  server = serve({ fetch: app.app.fetch, port: PORT });
  await new Promise<void>((resolve) => {
    if (server!.listening) resolve();
    else server!.once("listening", () => resolve());
  });
  // The bucket has to be registered with Miniflare before the S3 worker knows
  // about it; the seed's registration is fire-and-forget.
  await fetch(`http://127.0.0.1:${PORT}/client/v4/accounts/x/r2/buckets/app-uploads/objects/warmup`, {
    method: "PUT",
    body: "warmup",
  });
});

afterAll(async () => {
  server?.close();
  server?.closeAllConnections();
  await stopCloudflareEngine();
  resetFaultPlan();
});

describe("R2 S3-compatible front door", () => {
  it("round-trips a binary object with a real signed client", async () => {
    const client = makeClient();
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x7f]);

    await client.send(new PutObjectCommand({ Bucket: "app-uploads", Key: "img/logo.png", Body: bytes }));

    const head = await client.send(new HeadObjectCommand({ Bucket: "app-uploads", Key: "img/logo.png" }));
    expect(head.ContentLength).toBe(bytes.byteLength);

    const got = await client.send(new GetObjectCommand({ Bucket: "app-uploads", Key: "img/logo.png" }));
    const roundTripped = new Uint8Array(await got.Body!.transformToByteArray());
    expect(roundTripped).toEqual(bytes);
  });

  it("lists objects with a prefix", async () => {
    const client = makeClient();
    await client.send(new PutObjectCommand({ Bucket: "app-uploads", Key: "docs/a.txt", Body: "a" }));
    await client.send(new PutObjectCommand({ Bucket: "app-uploads", Key: "docs/b.txt", Body: "b" }));

    const listed = await client.send(new ListObjectsV2Command({ Bucket: "app-uploads", Prefix: "docs/" }));
    expect(listed.Contents?.map((object) => object.Key).sort()).toEqual(["docs/a.txt", "docs/b.txt"]);
  });

  it("deletes an object", async () => {
    const client = makeClient();
    await client.send(new PutObjectCommand({ Bucket: "app-uploads", Key: "tmp.txt", Body: "x" }));
    await client.send(new DeleteObjectCommand({ Bucket: "app-uploads", Key: "tmp.txt" }));
    await expect(client.send(new GetObjectCommand({ Bucket: "app-uploads", Key: "tmp.txt" }))).rejects.toThrow(
      /specified key does not exist/i,
    );
  });

  it("really verifies the signature", async () => {
    const wrong = makeClient("not-the-secret");
    await expect(
      wrong.send(new PutObjectCommand({ Bucket: "app-uploads", Key: "nope.txt", Body: "x" })),
    ).rejects.toThrow(/signature we calculated does not match/i);
  });

  it("shares storage with the Cloudflare REST object endpoints", async () => {
    const client = makeClient();
    await client.send(new PutObjectCommand({ Bucket: "app-uploads", Key: "shared.txt", Body: "from-s3" }));
    const viaRest = await fetch(
      `http://127.0.0.1:${PORT}/client/v4/accounts/x/r2/buckets/app-uploads/objects/shared.txt`,
    );
    expect(await viaRest.text()).toBe("from-s3");
  });
});
