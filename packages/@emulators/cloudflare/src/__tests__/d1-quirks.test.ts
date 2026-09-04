import { describe, it, expect, afterEach } from "vitest";
import { createHarness, type Harness, type D1Envelope } from "./helpers.js";

const DB_ID = "11111111-1111-4111-8111-111111111111";

let harness: Harness | undefined;

function open(): Harness {
  harness = createHarness({ d1: { databases: [{ name: "app_dev", id: DB_ID }] } });
  return harness;
}

async function count(h: Harness, table: string): Promise<number> {
  const body = (await (await h.query(DB_ID, `SELECT count(*) AS c FROM ${table}`)).json()) as D1Envelope;
  return (body.result[0].results as Array<{ c: number }>)[0].c;
}

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
});

/**
 * The quirk that decided the engine.
 *
 * drizzle-kit rebuilds a SQLite table by creating `__new_<table>`, copying the
 * rows across, dropping the original and renaming the copy, wrapped in
 * `PRAGMA foreign_keys=OFF` / `=ON`. In D1 that pragma is accepted with no
 * error and is a silent no-op, because workerd's Durable Object SQLite always
 * holds an open write transaction and SQLite documents `PRAGMA foreign_keys`
 * as a no-op inside a transaction. So `DROP TABLE parent` runs with foreign
 * keys still enforced and CASCADE deletes every child row, and the migration
 * reports success.
 *
 * Miniflare reproduces this because it IS workerd's SQLite. `node:sqlite`
 * honours the pragma and would report this migration as safe, which is worse
 * than having no emulator: it manufactures confidence about the exact failure
 * this emulator exists to catch.
 *
 * Corroboration: cloudflare/workerd#2471, drizzle-team/drizzle-orm#5782 and
 * #4089, and Cloudflare's own "D1 PRAGMA statements only apply to the current
 * transaction".
 *
 * If this test ever starts passing in the "child rows survive" direction, the
 * engine has stopped being D1 and the emulator is lying.
 */
describe("D1 fidelity quirks", () => {
  it("cascade-deletes children through a drizzle-kit __new_ table rebuild, exactly as real D1 does", async () => {
    const h = open();

    const setup = await h.query(
      DB_ID,
      [
        "CREATE TABLE `parent` (`id` text PRIMARY KEY, `name` text NOT NULL);",
        "CREATE TABLE `child` (",
        "\t`id` text PRIMARY KEY,",
        "\t`parent_id` text NOT NULL,",
        "\tCONSTRAINT `fk_child_parent` FOREIGN KEY (`parent_id`) REFERENCES `parent`(`id`) ON DELETE CASCADE",
        ");",
        "INSERT INTO `parent` (`id`, `name`) VALUES ('p1', 'one');",
        "INSERT INTO `child` (`id`, `parent_id`) VALUES ('c1', 'p1');",
        "INSERT INTO `child` (`id`, `parent_id`) VALUES ('c2', 'p1');",
      ].join("\n"),
    );
    expect(setup.status).toBe(200);
    expect(await count(h, "`parent`")).toBe(1);
    expect(await count(h, "`child`")).toBe(2);

    // Exactly the shape drizzle-kit emits for an ALTER that SQLite cannot do
    // in place, delivered as one migration file, which wrangler POSTs as one
    // multi-statement /query.
    const rebuild = await h.query(
      DB_ID,
      [
        "PRAGMA foreign_keys=OFF;",
        "--> statement-breakpoint",
        "CREATE TABLE `__new_parent` (",
        "\t`id` text PRIMARY KEY,",
        "\t`name` text NOT NULL,",
        "\t`nickname` text",
        ");",
        "--> statement-breakpoint",
        "INSERT INTO `__new_parent`(`id`, `name`) SELECT `id`, `name` FROM `parent`;",
        "--> statement-breakpoint",
        "DROP TABLE `parent`;",
        "--> statement-breakpoint",
        "ALTER TABLE `__new_parent` RENAME TO `parent`;",
        "--> statement-breakpoint",
        "PRAGMA foreign_keys=ON;",
      ].join("\n"),
    );

    // The migration reports total success. That is the trap: nothing anywhere
    // says the data is gone.
    expect(rebuild.status).toBe(200);
    const body = (await rebuild.json()) as D1Envelope;
    expect(body.success).toBe(true);
    expect(body.result.every((entry) => entry.success)).toBe(true);

    expect(await count(h, "`parent`")).toBe(1);
    // The child rows are gone. This is the bug, faithfully reproduced.
    expect(await count(h, "`child`")).toBe(0);
  });

  it("treats PRAGMA foreign_keys=OFF as a silent no-op", async () => {
    const h = open();
    const before = (await (await h.query(DB_ID, "PRAGMA foreign_keys")).json()) as D1Envelope;
    expect(before.result[0].results).toEqual([{ foreign_keys: 1 }]);

    const off = await h.query(DB_ID, "PRAGMA foreign_keys=OFF");
    // No error at all, which is what makes the quirk dangerous.
    expect(off.status).toBe(200);

    const after = (await (await h.query(DB_ID, "PRAGMA foreign_keys")).json()) as D1Envelope;
    expect(after.result[0].results).toEqual([{ foreign_keys: 1 }]);
  });

  it("still enforces foreign keys on insert", async () => {
    const h = open();
    await h.query(
      DB_ID,
      [
        "CREATE TABLE `parent` (`id` text PRIMARY KEY);",
        "CREATE TABLE `child` (`id` text PRIMARY KEY, `parent_id` text NOT NULL REFERENCES `parent`(`id`) ON DELETE CASCADE);",
      ].join("\n"),
    );
    const response = await h.query(DB_ID, "INSERT INTO `child` (`id`, `parent_id`) VALUES ('c1', 'missing')");
    expect(response.status).toBe(400);
    const body = (await response.json()) as { errors: Array<{ message: string }> };
    expect(body.errors[0].message).toMatch(/FOREIGN KEY constraint failed/i);
  });
});
