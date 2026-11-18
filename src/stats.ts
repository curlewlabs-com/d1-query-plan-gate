// Production-shape statistics: turning a cardinality model into sqlite_stat1
// rows, rendering them as an idempotent SQL payload for a live database, and
// seeding them into a test database so EXPLAIN QUERY PLAN chooses as it would
// in production instead of by the empty-table heuristic.
//
// sqlite_stat1.stat format: "<rows> [<avg_per_distinct_col1>
// [<avg_per_distinct_(col1,col2)> ...]]", one value per key prefix, all >= 1.
// A row giving fewer values than the index has key columns states nothing
// about the longer prefixes, so every row this module writes by default gives
// one value per key column, as SQLite's own ANALYZE does.

import type { PlanDatabase } from "./database";

export interface CardinalityModel {
  // Modeled row count per table. Every user table the schema holds must be
  // here; a table missing throws, because it would sit at the planner's
  // default-large heuristic while everything else claims to run under
  // production-shape statistics.
  readonly tables: Readonly<Record<string, number>>;
  // Full stat strings for the indexes whose default would mislead the
  // planner. An index absent here gets "<table rows> 1 ... 1", one 1 per key
  // column: each key prefix assumed unique.
  readonly indexes?: Readonly<Record<string, string>>;
}

// One index the schema holds: a sqlite_master index row, as `SELECT name,
// tbl_name FROM sqlite_master WHERE type='index'` returns it - or, for a
// WITHOUT ROWID table, its primary-key index, which has no sqlite_master row
// and which sqlite_stat1 records under the table's own name, so `name` is the
// table name. The model's `indexes` keys such an entry by the table name too.
// `columns` is the index's key width (`pragma_index_info`'s row count; for a
// WITHOUT ROWID key, its primary-key columns), which the default stat needs to
// give a value for every key prefix.
export interface SchemaIndexRow {
  name: string;
  tbl_name: string;
  columns: number;
}

export interface SqliteStat1Row {
  tbl: string;
  idx: string | null;
  stat: string;
}

// The sqlite_stat1 rows a schema should carry under `model`, given the
// schema's user tables and indexes. Throws when the model and the schema
// disagree: a table the model does not count, or an index entry the schema
// lacks.
export function buildSqliteStat1Rows(
  model: CardinalityModel,
  schemaTableNames: readonly string[],
  schemaIndexes: readonly SchemaIndexRow[],
): SqliteStat1Row[] {
  const tableRows = model.tables;
  const indexStats = model.indexes ?? {};
  const modeledTables = new Set(Object.keys(tableRows));

  const unmodeled = schemaTableNames.filter((name) => !modeledTables.has(name));
  if (unmodeled.length > 0) {
    throw new Error(
      `cardinality model is missing table row counts for: ${unmodeled.join(", ")}`,
    );
  }

  const realIndexNames = new Set(schemaIndexes.map((row) => row.name));
  const missingIndexes = Object.keys(indexStats).filter(
    (name) => !realIndexNames.has(name),
  );
  if (missingIndexes.length > 0) {
    throw new Error(
      `cardinality model references indexes not present in the schema: ${missingIndexes.join(", ")}`,
    );
  }

  const rowsOf = (name: string): number => {
    const rows = tableRows[name];
    if (
      rows !== undefined &&
      Object.prototype.hasOwnProperty.call(tableRows, name)
    ) {
      return rows;
    }
    throw new Error(
      `cardinality model is missing a table row count for: ${name}`,
    );
  };

  // Every table gets a table-level row (idx NULL), and every one comes before
  // any index row. SQLite takes a table's row count from that row and from a
  // non-partial index's row, whichever loads last, and never from a partial
  // index's row; rows load in the order they were inserted. So a table whose
  // indexes are all partial still gets the model's count, and one with a
  // non-partial index ends on that index's first value, as it would without
  // the table-level row.
  const rows: SqliteStat1Row[] = schemaTableNames.map((name) => ({
    tbl: name,
    idx: null,
    stat: String(rowsOf(name)),
  }));
  for (const { name, tbl_name, columns } of schemaIndexes) {
    if (!Number.isInteger(columns) || columns < 1) {
      throw new Error(
        `index ${name} has no key width (${columns}); pass its key column count as \`columns\``,
      );
    }
    rows.push({
      tbl: tbl_name,
      idx: name,
      stat: indexStats[name] ?? `${rowsOf(tbl_name)}${" 1".repeat(columns)}`,
    });
  }
  return rows;
}

export interface StatsSqlOptions {
  // Comment lines that open the file, each including its `-- ` prefix: say
  // what generated it and how to regenerate it.
  readonly header: readonly string[];
  // A small table the schema always holds, analyzed to bring sqlite_stat1
  // into existence (see renderStatsSql).
  readonly bootstrapTable: string;
}

// The payload that holds a live database's sqlite_stat1 to `rows`: a whole-
// table rewrite, so applying it twice lands the same table. The leading
// statement only needs to make sqlite_stat1 exist (a reserved name that cannot
// be CREATEd directly) so the DELETE and INSERTs have a table to target.
// Analyze a single small table, never a bare `ANALYZE`: the latter scans every
// table and index on the live database each time it runs - a rows-read cost
// that grows with the data - only for statistics the next line discards. The
// trailing `ANALYZE sqlite_master` is the documented reload trigger: without
// it, rows written to sqlite_stat1 are invisible to the planner on the
// connection that wrote them.
export function renderStatsSql(
  rows: readonly SqliteStat1Row[],
  options: StatsSqlOptions,
): string {
  const lines = [
    ...options.header,
    "",
    "-- Bootstrap sqlite_stat1 (reserved name - can't be CREATEd) via one 1-row",
    "-- table; a bare ANALYZE would full-scan the live DB for stats the next line",
    "-- discards. The INSERTs below are the pinned payload.",
    `ANALYZE ${options.bootstrapTable};`,
    "DELETE FROM sqlite_stat1;",
  ];

  for (const row of rows) {
    lines.push(
      `INSERT OR REPLACE INTO sqlite_stat1 (tbl, idx, stat) VALUES (${sqlString(row.tbl)}, ${row.idx === null ? "NULL" : sqlString(row.idx)}, ${sqlString(row.stat)});`,
    );
  }

  lines.push("ANALYZE sqlite_master;", "");
  return lines.join("\n");
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

interface NameRow {
  name: string;
}

// Seed the test database's sqlite_stat1 from `model`, so plans taken after
// this are the plans production-shape statistics produce. Run it after the
// schema is applied. The order is what D1 requires:
//
//   1. Enumerate the user tables and feed them to buildSqliteStat1Rows, whose
//      completeness check fails on a table the model does not know.
//   2. ANALYZE first: sqlite_stat1 is created lazily by the first ANALYZE, and
//      without it the INSERTs have no table to write into.
//   3. Replace every sqlite_stat1 row with the modeled rows, in one batch.
//   4. ANALYZE sqlite_master: the reload trigger. Without it the planner keeps
//      the statistics it loaded before the INSERTs.
export async function applyProductionStats(
  db: PlanDatabase,
  model: CardinalityModel,
): Promise<void> {
  // sqlite_*, _cf_* and d1_* are SQLite's and D1's own namespaces; no
  // application table lives there. The underscores are escaped because LIKE
  // reads `_` as any one character, which would also drop `acf_events` or
  // `d1logs` from the completeness check.
  const userTables = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' " +
        "AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' " +
        "AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' " +
        "AND name NOT LIKE 'd1\\_%' ESCAPE '\\'",
    )
    .all<NameRow>();
  const tableNames = userTables.results.map((row) => row.name);

  await db.prepare("ANALYZE").run();

  const placeholders = tableNames.map(() => "?").join(",");
  const enumerated = await db
    .prepare(
      "SELECT m.name, m.tbl_name, " +
        "(SELECT COUNT(*) FROM pragma_index_info(m.name)) AS columns " +
        `FROM sqlite_master m WHERE m.type='index' AND m.tbl_name IN (${placeholders})`,
    )
    .bind(...tableNames)
    .all<SchemaIndexRow>();
  // pragma_table_list's `wr` marks a WITHOUT ROWID table, whose primary key is
  // an index with no sqlite_master row; without it the key's statistics would
  // be missing while the model claimed the table.
  const withoutRowid = await db
    .prepare(
      "SELECT t.name, " +
        "(SELECT COUNT(*) FROM pragma_table_info(t.name) WHERE pk > 0) AS columns " +
        "FROM pragma_table_list t WHERE t.schema = 'main' AND t.type = 'table' AND t.wr = 1",
    )
    .all<{ name: string; columns: number }>();
  const modeled = new Set(tableNames);
  const primaryKeys = withoutRowid.results
    .filter((row) => modeled.has(row.name))
    .map((row) => ({
      name: row.name,
      tbl_name: row.name,
      columns: row.columns,
    }));

  const rows = buildSqliteStat1Rows(model, tableNames, [
    ...enumerated.results,
    ...primaryKeys,
  ]);
  // sqlite_stat1 has no key, so INSERT OR REPLACE replaces nothing: the rows
  // the ANALYZE above wrote for populated tables would stay beside the model's.
  // Clearing first, in the same batch, leaves exactly the model's rows, as the
  // rendered payload does.
  const inserts = rows.map((row) =>
    db
      .prepare(
        "INSERT OR REPLACE INTO sqlite_stat1 (tbl, idx, stat) VALUES (?, ?, ?)",
      )
      .bind(row.tbl, row.idx, row.stat),
  );
  await db.batch([db.prepare("DELETE FROM sqlite_stat1"), ...inserts]);

  await db.prepare("ANALYZE sqlite_master").run();
}
