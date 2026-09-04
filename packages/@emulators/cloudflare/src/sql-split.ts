/**
 * Server-side SQL statement splitting for the D1 REST API.
 *
 * D1's `/query` endpoint documents `sql` as "Supports multiple statements,
 * joined by semicolons, which will be executed as a batch", so the SERVER does
 * the splitting. Miniflare's D1 takes one statement per prepared statement, so
 * the emulator has to split before dispatching `db.batch(...)`, exactly as
 * `wrangler d1 execute --local` does.
 *
 * Never use `db.exec()` for this. The `cloudflare:d1` client shim compiled into
 * workerd splits `exec()` input by NEWLINE, which breaks on every multi-line
 * `CREATE TABLE` drizzle-kit emits, on `--> statement-breakpoint` comment
 * lines, and on leading `--` comments, and it misattributes error line numbers.
 *
 * This is a port of wrangler's `src/d1/splitter.ts` and `src/d1/trimmer.ts`
 * (verified against wrangler 4.128.0's bundled `splitSqlQuery`), which is
 * itself derived from `@databases/split-sql-query`
 * (https://github.com/ForbesLindesay/atdatabases, MIT).
 *
 * It is vendored rather than imported because wrangler is a ~10 MB CLI bundle
 * that carries its own copy of workerd; making it a runtime dependency of a
 * published emulator package to reach one pure function is not a trade worth
 * making. `src/__tests__/sql-split.test.ts` pins the behaviours that matter
 * (trigger bodies, comments, quoting, multi-line statements) so drift from
 * wrangler is detectable.
 */

export class SqlSplitError extends Error {}

function mayContainTransaction(sql: string): boolean {
  return sql.includes("BEGIN TRANSACTION");
}

/**
 * D1 runs every request in an implicit transaction and rejects explicit
 * transaction control, so a single wrapping `BEGIN TRANSACTION;`/`COMMIT;`
 * pair (what `sqlite3 .dump` emits) is stripped rather than passed through.
 */
export function trimSqlQuery(sql: string): string {
  if (!mayContainTransaction(sql)) return sql;
  const trimmed = sql.replace("BEGIN TRANSACTION;", "").replace("COMMIT;", "");
  if (mayContainTransaction(trimmed)) {
    throw new SqlSplitError(
      "The provided SQL contains several transactions. D1 runs your SQL in a transaction for you.",
    );
  }
  return trimmed;
}

function mayContainMultipleStatements(sql: string): boolean {
  const trimmed = sql.trimEnd();
  const semiColonIndex = trimmed.indexOf(";");
  return semiColonIndex !== -1 && semiColonIndex !== trimmed.length - 1;
}

function consumeWhile(iterator: Iterator<string>, predicate: (str: string) => boolean): string {
  let next = iterator.next();
  let str = "";
  while (!next.done) {
    str += next.value;
    if (!predicate(str)) break;
    next = iterator.next();
  }
  return str;
}

function consumeUntilMarker(iterator: Iterator<string>, endMarker: string): string {
  return consumeWhile(iterator, (str) => !str.endsWith(endMarker));
}

function isDollarQuoteIdentifier(str: string): boolean {
  const lastChar = str.slice(-1);
  // The $ marks the end of the identifier; numbers, underscores and letters
  // with diacritical marks are allowed inside it.
  return lastChar !== "$" && (/[0-9_]/i.test(lastChar) || lastChar.toLowerCase() !== lastChar.toUpperCase());
}

function isCompoundStatementStart(str: string): boolean {
  return /\s(BEGIN|CASE)\s$/i.test(str);
}

function isCompoundStatementEnd(str: string): boolean {
  return /\sEND[;\s]$/i.test(str);
}

function splitSqlIntoStatements(sql: string): string[] {
  const statements: string[] = [];
  let str = "";
  const compoundStatementStack: Array<(str: string) => boolean> = [];
  const iterator = sql[Symbol.iterator]();
  let next = iterator.next();

  while (!next.done) {
    const char = next.value;
    if (compoundStatementStack[0]?.(str + char)) {
      compoundStatementStack.shift();
    }
    switch (char) {
      case "'":
      case '"':
      case "`":
        str += char + consumeUntilMarker(iterator, char);
        break;
      case "$": {
        const dollarQuote = "$" + consumeWhile(iterator, isDollarQuoteIdentifier);
        str += dollarQuote;
        if (dollarQuote.endsWith("$")) {
          str += consumeUntilMarker(iterator, dollarQuote);
        }
        break;
      }
      case "-":
        next = iterator.next();
        if (!next.done && next.value === "-") {
          consumeUntilMarker(iterator, "\n");
          str += "\n";
          break;
        } else {
          str += char;
          continue;
        }
      case "/":
        next = iterator.next();
        if (!next.done && next.value === "*") {
          consumeUntilMarker(iterator, "*/");
          break;
        } else {
          str += char;
          continue;
        }
      case ";":
        if (compoundStatementStack.length === 0) {
          statements.push(str);
          str = "";
        } else {
          str += char;
        }
        break;
      default:
        str += char;
        break;
    }
    if (isCompoundStatementStart(str)) {
      compoundStatementStack.unshift(isCompoundStatementEnd);
    }
    next = iterator.next();
  }
  statements.push(str);
  return statements.map((statement) => statement.trim()).filter((statement) => statement.length > 0);
}

/**
 * Normalize CRLF to LF outside string literals and comments.
 *
 * Real D1's server-side splitter is broken by `\r` inside `CREATE TRIGGER`
 * bodies, and wrangler works around it by normalizing before POSTing. The
 * emulator normalizes on the way in so a client that does not is not punished
 * for a bug this emulator has no reason to reproduce.
 */
export function normalizeSqlLineEndings(sql: string): string {
  let normalized = "";
  let quoteEnd: string | undefined;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < sql.length; index++) {
    const char = sql[index];
    const nextChar = sql[index + 1];

    if (quoteEnd !== undefined) {
      normalized += char;
      if (char === quoteEnd) {
        if (nextChar === quoteEnd) {
          normalized += nextChar;
          index++;
        } else {
          quoteEnd = undefined;
        }
      }
      continue;
    }

    if (inLineComment) {
      if (char === "\r" && nextChar === "\n") {
        normalized += "\n";
        index++;
        inLineComment = false;
      } else {
        normalized += char;
        inLineComment = char !== "\n";
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "\r" && nextChar === "\n") {
        normalized += "\n";
        index++;
      } else {
        normalized += char;
        if (char === "*" && nextChar === "/") {
          normalized += nextChar;
          index++;
          inBlockComment = false;
        }
      }
      continue;
    }

    if (char === "-" && nextChar === "-") {
      normalized += "--";
      index++;
      inLineComment = true;
      continue;
    }
    if (char === "/" && nextChar === "*") {
      normalized += "/*";
      index++;
      inBlockComment = true;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      normalized += char;
      quoteEnd = char;
      continue;
    }
    if (char === "[") {
      normalized += char;
      quoteEnd = "]";
      continue;
    }
    if (char === "\r" && nextChar === "\n") {
      normalized += "\n";
      index++;
      continue;
    }
    normalized += char;
  }
  return normalized;
}

export function splitSqlQuery(sql: string): string[] {
  const trimmedSql = trimSqlQuery(normalizeSqlLineEndings(sql));
  if (!mayContainMultipleStatements(trimmedSql)) {
    const single = trimmedSql.trim();
    return single.length > 0 ? [single] : [];
  }
  const split = splitSqlIntoStatements(trimmedSql);
  if (split.length === 0) {
    const single = trimmedSql.trim();
    return single.length > 0 ? [single] : [];
  }
  return split;
}
