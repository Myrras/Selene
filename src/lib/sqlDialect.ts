/**
 * Maps a connection's {@link DriverId} to the matching `@codemirror/lang-sql`
 * dialect, so the editor highlights and completes keywords for the backend the
 * tab is actually talking to. Falls back to `StandardSQL` when there's no
 * connected session yet (the tab has no driver).
 */

import {
  MSSQL,
  MySQL,
  PostgreSQL,
  SQLDialect,
  SQLite,
  StandardSQL,
} from "@codemirror/lang-sql";

import type { DriverId } from "../ipc/types";

/**
 * Re-derives a dialect so its `keywords` beat its `builtin` list.
 *
 * lang-sql builds one word→token map and fills it in the order keywords → types
 * → builtin, so a word in *both* lists ends up tagged `Builtin`, which maps to
 * `standard(name)` — the same colour as an identifier in the GitHub themes.
 * MSSQL's builtin list ends with reserved words (`set`, `partition`, `sequence`,
 * `modify`, …), which is why `UPDATE t SET x = 1` rendered SET like a column
 * name. Stripping the overlap from `builtin` restores the keyword tag.
 */
function keywordsBeatBuiltins(d: SQLDialect): SQLDialect {
  const words = new Set((d.spec.keywords ?? "").split(" ").filter(Boolean));
  return SQLDialect.define({
    ...d.spec,
    builtin: (d.spec.builtin ?? "")
      .split(" ")
      .filter((w) => w && !words.has(w))
      .join(" "),
  });
}

/**
 * The MSSQL dialect Selene actually uses — plain `MSSQL` with the keyword/builtin
 * overlap resolved. Module-level so every caller shares one `LRLanguage`
 * instance (a per-call dialect would reconfigure the editor on every render).
 */
export const MSSQLDialect = keywordsBeatBuiltins(MSSQL);

/** The lang-sql dialect for a driver; `StandardSQL` when no driver is known. */
export function dialectFor(d: DriverId | undefined): SQLDialect {
  switch (d) {
    case "mssql":
      return MSSQLDialect;
    case "postgres":
      return PostgreSQL;
    case "mysql":
      return MySQL;
    case "sqlite":
      return SQLite;
    default:
      return StandardSQL;
  }
}
