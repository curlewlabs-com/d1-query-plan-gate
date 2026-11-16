import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import {
  applyProductionStats,
  buildSqliteStat1Rows,
  renderStatsSql,
  type CardinalityModel,
  type SqliteStat1Row,
} from "../src/index";

const SCHEMA = [
  "DROP TABLE IF EXISTS stats_events",
  "DROP TABLE IF EXISTS stats_meta",
  "CREATE TABLE stats_meta (id INTEGER PRIMARY KEY)",
  "CREATE TABLE stats_events (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, kind INTEGER NOT NULL)",
  "CREATE INDEX idx_stats_events_user ON stats_events(user_id)",
  "CREATE INDEX idx_stats_events_user_kind ON stats_events(user_id, kind)",
];

// Production shape: each user holds many events, and the composite index is
// the selective one.
const MODEL: CardinalityModel = {
  tables: { stats_events: 1_000_000, stats_meta: 1 },
  indexes: {
    idx_stats_events_user: "1000000 1000",
    idx_stats_events_user_kind: "1000000 10 1",
  },
};

async function applySchema(): Promise<void> {
  await env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql)));
}

// What a deploy's file import does with the payload: every statement, in
// order, one transaction.
async function applyPayload(payload: string): Promise<void> {
  const statements = payload
    .replace(/^\s*--[^\n]*$/gm, "")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
}

async function liveStat1(): Promise<SqliteStat1Row[]> {
  const rows = await env.DB.prepare(
    "SELECT tbl, idx, stat FROM sqlite_stat1 WHERE tbl LIKE 'stats_%' ORDER BY tbl, idx",
  ).all<SqliteStat1Row>();
  return rows.results;
}

const byKey = (rows: readonly SqliteStat1Row[]) =>
  [...rows].sort((a, b) =>
    `${a.tbl}|${a.idx ?? ""}`.localeCompare(`${b.tbl}|${b.idx ?? ""}`),
  );

async function planFor(sql: string): Promise<string> {
  const rows = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(1)
    .all<{ detail: string }>();
  return rows.results.map((row) => row.detail).join("\n");
}

describe("buildSqliteStat1Rows", () => {
  const indexes = [
    { name: "idx_a_x", tbl_name: "a" },
    { name: "idx_a_y", tbl_name: "a" },
  ];

  it("models every index and gives an unindexed table a table-level row", () => {
    const rows = buildSqliteStat1Rows(
      { tables: { a: 500, b: 7 }, indexes: { idx_a_y: "500 50 1" } },
      ["a", "b"],
      indexes,
    );
    expect(rows).toEqual([
      { tbl: "a", idx: "idx_a_x", stat: "500 1" },
      { tbl: "a", idx: "idx_a_y", stat: "500 50 1" },
      { tbl: "b", idx: null, stat: "7" },
    ]);
  });

  // Each throw is a model and schema that disagree. Left silent, the planner
  // would read the stray table or index at its default-large heuristic while
  // the suite claims production-shape statistics.
  it("throws when the model and the schema disagree", () => {
    expect(() =>
      buildSqliteStat1Rows({ tables: { a: 1 } }, ["a", "b"], indexes),
    ).toThrow("missing table row counts for: b");
    expect(() =>
      buildSqliteStat1Rows(
        { tables: { a: 1 }, indexes: { idx_gone: "1 1" } },
        ["a"],
        indexes,
      ),
    ).toThrow("indexes not present in the schema: idx_gone");
  });
});

describe("renderStatsSql", () => {
  // A bare ANALYZE scans every table and index of the live database, a cost
  // that grows with the data, for statistics the payload then discards.
  it("never runs a whole-database ANALYZE", () => {
    const sql = renderStatsSql([], {
      header: ["-- generated"],
      bootstrapTable: "stats_meta",
    });
    const statements = sql
      .split("\n")
      .filter((line) => !line.startsWith("--"))
      .join("\n");
    expect(statements).not.toMatch(/\bANALYZE\s*;/);
    expect(statements).toContain("ANALYZE stats_meta;");
  });

  // The payload is a whole-table rewrite: applied to a database on any prior
  // statistics, once or twice, it lands exactly the rendered rows, quotes in
  // names included.
  it("lands exactly its rows on D1, however often it runs", async () => {
    await applySchema();
    await env.DB.prepare("ANALYZE").run();
    await env.DB.prepare(
      "INSERT OR REPLACE INTO sqlite_stat1 (tbl, idx, stat) VALUES ('stats_events', 'idx_stats_events_user', '9 9')",
    ).run();
    const rows: SqliteStat1Row[] = [
      ...buildSqliteStat1Rows(
        MODEL,
        ["stats_events", "stats_meta"],
        [
          { name: "idx_stats_events_user", tbl_name: "stats_events" },
          { name: "idx_stats_events_user_kind", tbl_name: "stats_events" },
        ],
      ),
    ];
    const payload = renderStatsSql(rows, {
      header: ["-- generated"],
      bootstrapTable: "stats_meta",
    });

    await applyPayload(payload);
    expect(byKey(await liveStat1())).toEqual(byKey(rows));
    await applyPayload(payload);
    expect(byKey(await liveStat1())).toEqual(byKey(rows));
  });
});

describe("applyProductionStats", () => {
  // Poison-and-revert: seed extreme synthetic statistics that force the
  // planner onto the other index, then apply the model and require the
  // production-shape choice back. Comparing against a database with no
  // statistics instead would rest on row-format cost estimates that shift
  // whenever a column is added, and can converge on the same plan by accident.
  it("moves the planner back to the model's choice from poisoned statistics", async () => {
    await applySchema();
    const query = "SELECT id FROM stats_events WHERE user_id = ? LIMIT 10";

    await env.DB.prepare("ANALYZE").run();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR REPLACE INTO sqlite_stat1 (tbl, idx, stat) VALUES ('stats_events', 'idx_stats_events_user', '1000 1')",
      ),
      env.DB.prepare(
        "INSERT OR REPLACE INTO sqlite_stat1 (tbl, idx, stat) VALUES ('stats_events', 'idx_stats_events_user_kind', '10000000 1000000 1')",
      ),
    ]);
    await env.DB.prepare("ANALYZE sqlite_master").run();
    expect(await planFor(query)).toContain("idx_stats_events_user ");

    await applyProductionStats(env.DB, MODEL);
    expect(await planFor(query)).toContain("idx_stats_events_user_kind");
    expect(byKey(await liveStat1())).toEqual(
      byKey([
        {
          tbl: "stats_events",
          idx: "idx_stats_events_user",
          stat: "1000000 1000",
        },
        {
          tbl: "stats_events",
          idx: "idx_stats_events_user_kind",
          stat: "1000000 10 1",
        },
        { tbl: "stats_meta", idx: null, stat: "1" },
      ]),
    );
  });

  // The completeness guard runs against the live schema, so a table the model
  // forgot fails the seed instead of planning at the default heuristic.
  it("refuses a schema holding a table the model does not know", async () => {
    await applySchema();
    await expect(
      applyProductionStats(env.DB, { tables: { stats_events: 1 } }),
    ).rejects.toThrow("missing table row counts for: stats_meta");
  });

  // sqlite_stat1 has no key, so on populated tables the ANALYZE that creates
  // it leaves rows an INSERT OR REPLACE does not replace. The seed must leave
  // exactly the model's rows, however often it runs.
  it("leaves exactly the model's rows on populated tables", async () => {
    await applySchema();
    await env.DB.batch([
      env.DB.prepare("DROP TABLE IF EXISTS stats_log"),
      env.DB.prepare(
        "CREATE TABLE stats_log (id INTEGER PRIMARY KEY, line TEXT)",
      ),
      ...Array.from({ length: 20 }, (_, i) =>
        env.DB.prepare(
          "INSERT INTO stats_events (user_id, kind) VALUES (?, ?)",
        ).bind(i % 3, i % 2),
      ),
      env.DB.prepare("INSERT INTO stats_log (line) VALUES ('x')"),
    ]);
    const model: CardinalityModel = {
      ...MODEL,
      tables: { ...MODEL.tables, stats_log: 10 },
    };

    await applyProductionStats(env.DB, model);
    await applyProductionStats(env.DB, model);
    expect(byKey(await liveStat1())).toEqual(
      byKey([
        {
          tbl: "stats_events",
          idx: "idx_stats_events_user",
          stat: "1000000 1000",
        },
        {
          tbl: "stats_events",
          idx: "idx_stats_events_user_kind",
          stat: "1000000 10 1",
        },
        { tbl: "stats_meta", idx: null, stat: "1" },
        { tbl: "stats_log", idx: null, stat: "10" },
      ]),
    );
    await env.DB.exec("DROP TABLE stats_log");
  });

  // LIKE reads `_` as any one character, so an unescaped `_cf_%` or `d1_%`
  // filter would drop these ordinary tables from the completeness check.
  it("checks tables whose names only resemble a reserved prefix", async () => {
    await applySchema();
    await env.DB.batch([
      env.DB.prepare("CREATE TABLE acf_events (id INTEGER PRIMARY KEY)"),
      env.DB.prepare("CREATE TABLE d1logs (id INTEGER PRIMARY KEY)"),
    ]);
    try {
      await expect(applyProductionStats(env.DB, MODEL)).rejects.toThrow(
        "missing table row counts for: acf_events, d1logs",
      );
    } finally {
      await env.DB.exec("DROP TABLE acf_events");
      await env.DB.exec("DROP TABLE d1logs");
    }
  });

  // A WITHOUT ROWID table's primary key is an index with no sqlite_master
  // row, which SQLite's sqlite_stat1 records under the table's own name;
  // missed, its key statistics were absent while the model claimed the table.
  it("seeds a WITHOUT ROWID table's primary key under the table's name", async () => {
    await applySchema();
    await env.DB.exec(
      "CREATE TABLE stats_pairs (a INTEGER NOT NULL, b INTEGER NOT NULL, PRIMARY KEY (a, b)) WITHOUT ROWID",
    );
    try {
      const tables = { ...MODEL.tables, stats_pairs: 5000 };
      await applyProductionStats(env.DB, { ...MODEL, tables });
      expect(
        (await liveStat1()).filter((row) => row.tbl === "stats_pairs"),
      ).toEqual([{ tbl: "stats_pairs", idx: "stats_pairs", stat: "5000 1" }]);

      await applyProductionStats(env.DB, {
        tables,
        indexes: { ...MODEL.indexes, stats_pairs: "5000 50 1" },
      });
      expect(
        (await liveStat1()).filter((row) => row.tbl === "stats_pairs"),
      ).toEqual([
        { tbl: "stats_pairs", idx: "stats_pairs", stat: "5000 50 1" },
      ]);
    } finally {
      await env.DB.exec("DROP TABLE stats_pairs");
    }
  });
});
