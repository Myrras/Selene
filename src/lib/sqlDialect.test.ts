import { describe, expect, it } from "vitest";
import { MySQL, PostgreSQL, SQLite, StandardSQL } from "@codemirror/lang-sql";

import { dialectFor, MSSQLDialect } from "./sqlDialect";

/** The node name lang-sql's tokenizer assigns to each word in `sql`. */
function tokenNames(sql: string): Record<string, string> {
  const out: Record<string, string> = {};
  MSSQLDialect.language.parser.parse(sql).iterate({
    enter: (n) => {
      const text = sql.slice(n.from, n.to);
      if (n.name !== "Script" && n.name !== "Statement") out[text] = n.name;
    },
  });
  return out;
}

describe("dialectFor", () => {
  it("maps each driver to its lang-sql dialect", () => {
    expect(dialectFor("mssql")).toBe(MSSQLDialect);
    expect(dialectFor("postgres")).toBe(PostgreSQL);
    expect(dialectFor("mysql")).toBe(MySQL);
    expect(dialectFor("sqlite")).toBe(SQLite);
  });

  it("falls back to StandardSQL when no driver is known", () => {
    expect(dialectFor(undefined)).toBe(StandardSQL);
  });
});

describe("MSSQLDialect", () => {
  // Stock MSSQL lists `set` (and `partition`, `sequence`, …) as a builtin as
  // well as a keyword, and builtin wins — tagging SET like an identifier.
  it("tokenizes reserved words shadowed by the builtin list as keywords", () => {
    const t = tokenNames("UPDATE t SET a = 1 WHERE id = 2");
    expect(t.SET).toBe("Keyword");
    expect(t.UPDATE).toBe("Keyword");
    expect(t.WHERE).toBe("Keyword");
    expect(t.a).toBe("Identifier");
  });

  it("keeps genuine builtins out of the keyword tag", () => {
    expect(tokenNames("SELECT GETDATE()").GETDATE).toBe("Builtin");
  });
});
