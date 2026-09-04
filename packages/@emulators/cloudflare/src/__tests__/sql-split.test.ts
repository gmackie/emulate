import { describe, it, expect } from "vitest";
import { splitSqlQuery, normalizeSqlLineEndings } from "../sql-split.js";

describe("splitSqlQuery", () => {
  it("keeps a single statement intact", () => {
    expect(splitSqlQuery("SELECT 1")).toEqual(["SELECT 1"]);
    expect(splitSqlQuery("SELECT 1;")).toEqual(["SELECT 1;"]);
  });

  it("splits a drizzle-kit migration file on semicolons, not newlines", () => {
    const migration = [
      "CREATE TABLE `post` (",
      "\t`id` text PRIMARY KEY,",
      "\t`title` text NOT NULL",
      ");",
      "--> statement-breakpoint",
      "CREATE INDEX `post_title_idx` ON `post` (`title`);",
    ].join("\n");
    const parts = splitSqlQuery(migration);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain("CREATE TABLE `post`");
    expect(parts[1]).toContain("CREATE INDEX");
  });

  it("drops comment-only lines rather than emitting an empty statement", () => {
    expect(splitSqlQuery("-- a leading comment\nSELECT 1;\n-- trailing")).toEqual(["SELECT 1"]);
  });

  it("does not split inside a trigger body", () => {
    const sql = "CREATE TRIGGER t AFTER INSERT ON a BEGIN INSERT INTO b VALUES (1); END; SELECT 1;";
    const parts = splitSqlQuery(sql);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain("END");
    expect(parts[1]).toBe("SELECT 1");
  });

  it("does not split inside string literals or quoted identifiers", () => {
    const parts = splitSqlQuery(`INSERT INTO t VALUES ('a;b'); INSERT INTO "x;y" VALUES (1);`);
    expect(parts).toEqual([`INSERT INTO t VALUES ('a;b')`, `INSERT INTO "x;y" VALUES (1)`]);
  });

  it("strips a wrapping BEGIN TRANSACTION/COMMIT pair", () => {
    const parts = splitSqlQuery("BEGIN TRANSACTION;\nINSERT INTO t VALUES (1);\nCOMMIT;");
    expect(parts).toEqual(["INSERT INTO t VALUES (1);"]);
  });

  it("returns nothing for whitespace-only SQL", () => {
    expect(splitSqlQuery("   \n  ")).toEqual([]);
  });
});

describe("normalizeSqlLineEndings", () => {
  it("normalizes CRLF outside literals", () => {
    expect(normalizeSqlLineEndings("SELECT 1;\r\nSELECT 2;")).toBe("SELECT 1;\nSELECT 2;");
  });

  it("leaves CRLF inside a string literal alone", () => {
    expect(normalizeSqlLineEndings("SELECT 'a\r\nb'")).toBe("SELECT 'a\r\nb'");
  });
});
