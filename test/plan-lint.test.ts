import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import {
  hasStructurallyBoundedResult,
  keyGroupId,
  parseSearchRow,
  planVirtualTableSources,
  qKeyGroups,
  qRangeSearchFindings,
  qScanFindings,
  type KeyGroupContext,
  type PlanRow,
  type QueryPlanFinding,
} from "../src/index";

type Finding = QueryPlanFinding;

async function planOf(sql: string, ...binds: unknown[]): Promise<PlanRow[]> {
  return (
    await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .bind(...binds)
      .all<PlanRow>()
  ).results;
}

describe("plan lint", () => {
  // Guards the distinction between a bounded partial-index working set and a
  // soft-delete partial that is effectively a full-table scan, on a plan D1
  // itself chose.
  it("a SCAN riding an unbounded partial index is not exempt", async () => {
    await env.DB.exec(
      "CREATE TABLE lint_fixture_archived (id INTEGER PRIMARY KEY, archived_at INTEGER)",
    );
    await env.DB.exec(
      "CREATE INDEX idx_lint_fixture_archived ON lint_fixture_archived(id) WHERE archived_at IS NULL",
    );
    try {
      const fixtureSql =
        "SELECT id FROM lint_fixture_archived WHERE archived_at IS NULL";
      const plan = await planOf(fixtureSql);
      expect(
        plan.some((row) =>
          /USING INDEX idx_lint_fixture_archived/.test(row.detail),
        ),
      ).toBe(true);

      const parentRows = 1_000_000;
      const base = {
        userTableNames: new Set(["lint_fixture_archived"]),
        partialIndexNames: new Set(["idx_lint_fixture_archived"]),
        parentRowCounts: new Map([["lint_fixture_archived", parentRows]]),
      };
      const findingsFor = (partialRows: number) =>
        qScanFindings("FIXTURE", fixtureSql, plan, {
          ...base,
          modeledIndexRows: new Map([
            ["idx_lint_fixture_archived", partialRows],
          ]),
        });

      const unbounded = findingsFor(parentRows);
      expect(unbounded).toHaveLength(1);
      expect(unbounded[0]!.rule).toBe("no-unbounded-partial-index");
      expect(unbounded[0]!.table).toBe("lint_fixture_archived");
      expect(unbounded[0]!.index).toBe("idx_lint_fixture_archived");

      // Exactly an order-of-magnitude reduction is the bounded boundary.
      expect(findingsFor(parentRows / 10)).toEqual([]);
      expect(findingsFor(parentRows / 10 + 1)).toHaveLength(1);
      expect(findingsFor(100)).toEqual([]);
      // Fail closed: an unmodeled partial cannot prove its bound.
      expect(
        qScanFindings("FIXTURE", fixtureSql, plan, {
          ...base,
          modeledIndexRows: new Map(),
        }),
      ).toHaveLength(1);
    } finally {
      await env.DB.exec("DROP TABLE lint_fixture_archived");
    }
  });

  // An aliased SCAN that the alias map missed would pass silently; and a table
  // the statement does not name is SQLite's FK-integrity probe, which the SCAN
  // rule leaves to the schema.
  it("SCAN rule resolves aliases and counts only tables the SQL names", async () => {
    await env.DB.exec(
      "CREATE TABLE lint_parent (id INTEGER PRIMARY KEY, name TEXT)",
    );
    await env.DB.exec(
      "CREATE TABLE lint_child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES lint_parent(id))",
    );
    try {
      const ctx = {
        userTableNames: new Set(["lint_parent", "lint_child"]),
        partialIndexNames: new Set<string>(),
        modeledIndexRows: new Map<string, number>(),
        parentRowCounts: new Map<string, number>(),
      };
      const aliased = "SELECT p.id FROM lint_parent p WHERE p.name = ?";
      const findings = qScanFindings(
        "BY_NAME",
        aliased,
        await planOf(aliased, "x"),
        ctx,
      );
      expect(findings.map((f) => [f.rule, f.table, f.q])).toEqual([
        ["no-scan-on-user-tables", "lint_parent", "BY_NAME"],
      ]);

      const fkProbe = [{ detail: "SCAN lint_child" }];
      expect(
        qScanFindings(
          "DELETE_PARENT",
          "DELETE FROM lint_parent WHERE id = ?",
          fkProbe,
          ctx,
        ),
      ).toEqual([]);
    } finally {
      await env.DB.exec("DROP TABLE lint_child");
      await env.DB.exec("DROP TABLE lint_parent");
    }
  });

  // The parser enumerates the detail shapes it reads, so the shapes D1 really
  // prints for a range seek and a json_each source must be among them.
  it("reads the range and virtual-table rows D1 prints", async () => {
    await env.DB.exec(
      "CREATE TABLE lint_events (id INTEGER PRIMARY KEY, sent_at INTEGER NOT NULL)",
    );
    await env.DB.exec(
      "CREATE INDEX idx_lint_events_sent ON lint_events(sent_at)",
    );
    try {
      const ctx = {
        userTableNames: new Set(["lint_events"]),
        partialIndexNames: new Set<string>(),
        modeledIndexRows: new Map<string, number>(),
        parentRowCounts: new Map<string, number>(),
      };
      const upper = "SELECT id FROM lint_events WHERE sent_at < ?";
      expect(
        qRangeSearchFindings("UPPER", upper, await planOf(upper, 1), ctx).map(
          (f) => [f.rule, f.index],
        ),
      ).toEqual([["no-unbounded-range-search", "idx_lint_events_sent"]]);
      const window =
        "SELECT id FROM lint_events WHERE sent_at > ? AND sent_at < ?";
      expect(
        qRangeSearchFindings("WINDOW", window, await planOf(window, 1, 2), ctx),
      ).toEqual([]);

      const each =
        "SELECT e.id FROM lint_events e WHERE e.id IN (SELECT value FROM json_each(?))";
      expect(planVirtualTableSources(await planOf(each, "[1]"))).toHaveLength(
        1,
      );
    } finally {
      await env.DB.exec("DROP TABLE lint_events");
    }
  });

  // Drives each directional constraint independently of the plans the live
  // schema happens to produce.
  it("range rule: classifies boundedness by direction and partial bound", () => {
    const run = (
      detail: string,
      opts: {
        sql: string;
        tables: string[];
        partials?: Array<[string, number]>;
        parents?: Array<[string, number]>;
      },
    ): Finding[] =>
      qRangeSearchFindings("FIXTURE", opts.sql, [{ detail }], {
        userTableNames: new Set(opts.tables),
        partialIndexNames: new Set((opts.partials ?? []).map(([name]) => name)),
        modeledIndexRows: new Map(opts.partials ?? []),
        parentRowCounts: new Map(opts.parents ?? []),
      });

    const unbounded = run("SEARCH e USING INDEX idx_sent (sent_at<?)", {
      sql: "SELECT 1 FROM events e",
      tables: ["events"],
    });
    expect(unbounded).toHaveLength(1);
    expect(unbounded[0]!.rule).toBe("no-unbounded-range-search");
    expect(unbounded[0]!.table).toBe("events");
    expect(unbounded[0]!.index).toBe("idx_sent");

    expect(
      run("SEARCH e USING INDEX idx_sent (sent_at>? AND sent_at<?)", {
        sql: "SELECT 1 FROM events e",
        tables: ["events"],
      }),
    ).toEqual([]);
    expect(
      run("SEARCH j USING INDEX idx_pending (due_at>?)", {
        sql: "SELECT 1 FROM jobs j",
        tables: ["jobs"],
        partials: [["idx_pending", 900_000]],
        parents: [["jobs", 1_500_000]],
      }),
    ).toEqual([]);
    expect(
      run(
        "SEARCH r USING COVERING INDEX idx_uid_ts (user_id=? AND taken_at>?)",
        { sql: "SELECT 1 FROM readings r", tables: ["readings"] },
      ),
    ).toEqual([]);

    const eqUpper = run(
      "SEARCH e USING INDEX idx_mode_sent (mode=? AND sent_at<?)",
      { sql: "SELECT 1 FROM events e", tables: ["events"] },
    );
    expect(eqUpper).toHaveLength(1);
    expect(eqUpper[0]!.rule).toBe("no-unbounded-range-search");
    expect(eqUpper[0]!.index).toBe("idx_mode_sent");

    expect(
      run("SEARCH s USING INDEX idx_due (last_sent_at<?)", {
        sql: "SELECT 1 FROM reminders s",
        tables: ["reminders"],
        partials: [["idx_due", 1_000]],
        parents: [["reminders", 25_000]],
      }),
    ).toEqual([]);

    const unboundedPartial = run(
      "SEARCH s USING INDEX idx_due (last_sent_at<?)",
      {
        sql: "SELECT 1 FROM reminders s",
        tables: ["reminders"],
        partials: [["idx_due", 5_000]],
        parents: [["reminders", 25_000]],
      },
    );
    expect(unboundedPartial).toHaveLength(1);
    expect(unboundedPartial[0]!.index).toBe("idx_due");

    const pkRange = run("SEARCH e USING INTEGER PRIMARY KEY (rowid<?)", {
      sql: "SELECT 1 FROM events e",
      tables: ["events"],
    });
    expect(pkRange).toHaveLength(1);
    expect(pkRange[0]!.rule).toBe("no-unbounded-range-search");
    expect(pkRange[0]!.table).toBe("events");
    expect(pkRange[0]!.index).toBe("INTEGER PRIMARY KEY");

    expect(
      run("SEARCH e USING INTEGER PRIMARY KEY (rowid=?)", {
        sql: "SELECT 1 FROM events e",
        tables: ["events"],
      }),
    ).toEqual([]);

    const blobPkRange = run("SEARCH b USING PRIMARY KEY (id<?)", {
      sql: "SELECT 1 FROM links b",
      tables: ["links"],
    });
    expect(blobPkRange).toHaveLength(1);
    expect(blobPkRange[0]!.index).toBe("PRIMARY KEY");
  });
  // The key-group classifier boundaries. The expression-index branch in
  // particular fails CLOSED by design, and a schema without an expression index
  // would never notice it inverting.
  it("key groups: what is pinned, what is in scope, and what fails closed", () => {
    const ctx: KeyGroupContext = {
      userTableNames: new Set(["pairs", "devices"]),
      uniqueIndexNames: new Set(["uniq_pair", "uniq_expr"]),
      partialIndexPredicates: new Map([["part_live", "status = 1"]]),
      nullableKeyIndexNames: new Set(),
      // uniq_expr is absent: an expression column reports a NULL name, so its
      // column count is unknowable and the pinned test must not clear it.
      indexNamedColumnCounts: new Map([
        ["uniq_pair", 2],
        ["part_live", 2],
        ["plain_idx", 1],
      ]),
    };
    const groups = (detail: string, sql = "SELECT 1 FROM pairs LIMIT 1") =>
      qKeyGroups(sql, [{ detail }], ctx).map(keyGroupId);

    // A UNIQUE index with every column equality-matched reaches one row.
    expect(
      groups("SEARCH pairs USING INDEX uniq_pair (a_id=? AND b_id=?)"),
    ).toEqual([]);
    // The same index only partly matched pins a GROUP, not a key.
    expect(groups("SEARCH pairs USING INDEX uniq_pair (a_id=?)")).toEqual([
      "pairs | uniq_pair | (a_id=?)",
    ]);
    // Fail closed on an expression column: UNIQUE and equality-matched, but the
    // column count is unknown, so it cannot be proven to reach one row.
    expect(groups("SEARCH pairs USING INDEX uniq_expr (a_id=?)")).toEqual([
      "pairs | uniq_expr | (a_id=?)",
    ]);
    // A partial's predicate is part of the key: dropping it must change the id.
    expect(groups("SEARCH pairs USING INDEX part_live (a_id=?)")).toEqual([
      "pairs | part_live WHERE status = 1 | (a_id=?)",
    ]);
    // A table the SQL does not name is SQLite's FK-integrity pass, not the
    // query's own work - excluded by the SCAN rule on the same ground.
    expect(groups("SEARCH devices USING INDEX plain_idx (user_id=?)")).toEqual(
      [],
    );
    // A retention sweep is out of scope because its LIMIT is a batch size, NOT
    // because it is a mutation. The cases below are the whole scope rule,
    // and the others are what a blanket mutation skip would wrongly drop: a
    // cap COUNT or a recomputed MAX is a bounded read over an accumulating
    // group that happens to sit inside an UPDATE or INSERT.
    expect(
      groups(
        "SEARCH pairs USING INDEX plain_idx (a_id=?)",
        "DELETE FROM pairs WHERE a_id = ? LIMIT 1000",
      ),
    ).toEqual([]);
    expect(
      groups(
        "SEARCH pairs USING INDEX plain_idx (a_id=?)",
        "UPDATE pairs SET status = 1 WHERE id = ? AND (SELECT COUNT(*) FROM pairs WHERE a_id = ?) < 5",
      ),
    ).toEqual(["pairs | plain_idx | (a_id=?)"]);
    expect(
      groups(
        "SEARCH pairs USING INDEX plain_idx (a_id=?)",
        "INSERT INTO pairs SELECT 1 WHERE (SELECT COUNT(*) FROM pairs WHERE a_id = ?) < 5",
      ),
    ).toEqual(["pairs | plain_idx | (a_id=?)"]);
    // A read whose result is not structurally bounded is not this shape.
    expect(
      groups(
        "SEARCH pairs USING INDEX plain_idx (a_id=?)",
        "SELECT id FROM pairs WHERE a_id = ?",
      ),
    ).toEqual([]);
  });

  // SQLite prints an EXISTS semi-join as `SEARCH d EXISTS USING ...`. Each
  // engine anchors alias and access path on adjacent tokens, so without the
  // normalizer the range rule and the key groups silently skip the row and rule
  // 10 loses the index - the first two fail OPEN, which no live plan would
  // surface until a query regressed inside an EXISTS.
  it("every engine reads a row carrying the EXISTS semi-join marker", () => {
    const scanCtx = {
      userTableNames: new Set(["events"]),
      partialIndexNames: new Set(["idx_live"]),
      modeledIndexRows: new Map([["idx_live", 100]]),
      parentRowCounts: new Map([["events", 1_000_000]]),
    };
    const sql = "SELECT 1 FROM events e LIMIT 1";

    const range = qRangeSearchFindings(
      "FIXTURE",
      sql,
      [{ detail: "SEARCH e EXISTS USING INDEX idx_sent (sent_at<?)" }],
      scanCtx,
    );
    expect(range.map((f) => [f.rule, f.index])).toEqual([
      ["no-unbounded-range-search", "idx_sent"],
    ]);

    // The bounded partial exempts the SCAN only if the index survives parsing.
    expect(
      qScanFindings(
        "FIXTURE",
        sql,
        [{ detail: "SCAN e EXISTS USING INDEX idx_live" }],
        scanCtx,
      ),
    ).toEqual([]);

    const groups = qKeyGroups(
      sql,
      [
        {
          detail: "SEARCH e EXISTS USING INDEX plain_idx (user_id=?)",
        },
      ],
      {
        userTableNames: new Set(["events"]),
        uniqueIndexNames: new Set(),
        partialIndexPredicates: new Map(),
        indexNamedColumnCounts: new Map([["plain_idx", 1]]),
        nullableKeyIndexNames: new Set(),
      },
    ).map(keyGroupId);
    expect(groups).toEqual(["events | plain_idx | (user_id=?)"]);
  });

  // A skipped row reads as "fine" to the range rule and the key groups, so an unknown
  // shape must stop the lint rather than shrink what it checks - the failure
  // the EXISTS marker produced before it was read.
  it("a SEARCH row in an unread shape throws instead of being skipped", () => {
    const sql = "SELECT 1 FROM events e LIMIT 1";
    const unknown = [
      { detail: "SEARCH e SEMI USING INDEX idx_sent (sent_at<?)" },
      { detail: "SEARCH e USING INDEX idx_sent (sent_at<?) RIGHT-JOIN" },
    ];
    for (const row of unknown) {
      expect(() =>
        qRangeSearchFindings("FIXTURE", sql, [row], {
          userTableNames: new Set(["events"]),
          partialIndexNames: new Set(),
          modeledIndexRows: new Map(),
          parentRowCounts: new Map(),
        }),
      ).toThrow(row.detail);
      expect(() =>
        qKeyGroups(sql, [row], {
          userTableNames: new Set(["events"]),
          uniqueIndexNames: new Set(),
          partialIndexPredicates: new Map(),
          indexNamedColumnCounts: new Map(),
          nullableKeyIndexNames: new Set(),
        }),
      ).toThrow(row.detail);
    }

    // The same holds one level down, for the access method: a key-group reader
    // that skipped an unnamed method would enroll nothing for it. A primary-key
    // seek is the classified skip.
    const keyGroupCtx = {
      userTableNames: new Set(["events"]),
      uniqueIndexNames: new Set<string>(),
      partialIndexPredicates: new Map<string, string>(),
      indexNamedColumnCounts: new Map<string, number>(),
      nullableKeyIndexNames: new Set<string>(),
    };
    // A WITHOUT ROWID table's PRIMARY KEY may be composite, so a prefix seek on
    // it reaches a group; only the rowid is a classified one-row skip.
    for (const unclassified of [
      "SEARCH e USING AUTOMATIC COVERING INDEX (user_id=?)",
      "SEARCH e USING PRIMARY KEY (user_id=?)",
    ]) {
      expect(() =>
        qKeyGroups(sql, [{ detail: unclassified }], keyGroupCtx),
      ).toThrow(unclassified);
    }
    expect(
      qKeyGroups(
        sql,
        [{ detail: "SEARCH e USING INTEGER PRIMARY KEY (rowid=?)" }],
        keyGroupCtx,
      ),
    ).toEqual([]);

    // The MIN/MAX end seeks read one row and carry no seek key, so they parse
    // and classify as nothing rather than throwing.
    for (const detail of [
      "SEARCH e USING COVERING INDEX idx_sent",
      "SEARCH e",
    ]) {
      expect(parseSearchRow(detail)).toEqual({
        target: "e",
        method: detail === "SEARCH e" ? undefined : "COVERING INDEX idx_sent",
        constraint: undefined,
      });
    }
    // A json_each source walks its bound array, not a table: it parses with no
    // seek key here, and the caller's cap on the bound value is its bound.
    expect(parseSearchRow("SEARCH bk VIRTUAL TABLE INDEX 1:")).toEqual({
      target: "bk",
      method: "VIRTUAL TABLE INDEX 1:",
      constraint: undefined,
    });
    // SQLite prints a virtual-table read as SCAN or SEARCH, and each must be
    // enumerated for the caller to check.
    expect(
      planVirtualTableSources([
        { detail: "SCAN bk VIRTUAL TABLE INDEX 0:" },
        { detail: "SEARCH bk VIRTUAL TABLE INDEX 1:" },
        { detail: "SCAN readings" },
      ]),
    ).toEqual(["bk", "bk"]);
  });

  // The range rule decides by the range terms it finds, so a term it skipped read as
  // "no range": an upper-bound-only seek on an expression index, printed
  // `<expr><?`, passed unflagged before terms were read rather than matched.
  it("range rule reads every constraint term shape and throws on any other", () => {
    const ctx = {
      userTableNames: new Set(["readings"]),
      partialIndexNames: new Set<string>(),
      modeledIndexRows: new Map<string, number>(),
      parentRowCounts: new Map<string, number>(),
    };
    const sql = "SELECT 1 FROM readings r LIMIT 1";
    const rangeRules = (detail: string) =>
      qRangeSearchFindings("FIXTURE", sql, [{ detail }], ctx).map(
        (f) => f.rule,
      );

    expect(rangeRules("SEARCH r USING INDEX idx_expr (<expr><?)")).toEqual([
      "no-unbounded-range-search",
    ]);
    // A skip-scan nests `ANY(col)` in the paren; the row parses and its range
    // term still classifies.
    expect(
      rangeRules(
        "SEARCH r USING COVERING INDEX idx_uid_type_ts (ANY(user_id) AND ANY(kind) AND taken_at<?)",
      ),
    ).toEqual(["no-unbounded-range-search"]);
    expect(
      rangeRules(
        "SEARCH r USING COVERING INDEX idx_uid_type_ts (ANY(user_id) AND taken_at>?)",
      ),
    ).toEqual([]);

    const unknown = "SEARCH r USING INDEX idx_ts (taken_at IN ?)";
    expect(() => rangeRules(unknown)).toThrow("taken_at IN ?");
    expect(() => parseSearchRow(unknown)).toThrow(unknown);
  });

  it("key groups: which result shapes count as structurally bounded", () => {
    expect(hasStructurallyBoundedResult("SELECT a FROM t LIMIT 1")).toBe(true);
    expect(hasStructurallyBoundedResult("SELECT a FROM t LIMIT 8")).toBe(true);
    expect(hasStructurallyBoundedResult("SELECT COUNT(*) FROM t")).toBe(true);
    expect(hasStructurallyBoundedResult("SELECT MAX(ts) FROM t")).toBe(true);
    // A caller-supplied LIMIT is not structurally bounded - the count comes
    // from outside the statement.
    expect(hasStructurallyBoundedResult("SELECT a FROM t LIMIT :n")).toBe(
      false,
    );
    // An aggregate under GROUP BY returns one row PER GROUP, so the result
    // tracks the walk rather than staying flat against it.
    expect(
      hasStructurallyBoundedResult(
        "SELECT user_id, COUNT(*) FROM t GROUP BY user_id",
      ),
    ).toBe(false);
    expect(hasStructurallyBoundedResult("SELECT a FROM t")).toBe(false);

    // On a mutation the top-level LIMIT is a batch size, so it does not make
    // the statement bounded-result - that is what keeps retention sweeps out.
    // An aggregate inside one still does: the two are not the same claim, and
    // conflating them drops every aggregate-bearing UPDATE.
    expect(
      hasStructurallyBoundedResult(
        "DELETE FROM t WHERE id IN (SELECT id FROM t WHERE created_at < ? LIMIT 1000)",
      ),
    ).toBe(false);
    expect(
      hasStructurallyBoundedResult(
        "UPDATE t SET a = (SELECT MAX(ts) FROM s WHERE s.u = ?)",
      ),
    ).toBe(true);
    expect(
      hasStructurallyBoundedResult(
        "UPDATE t SET a = 1 WHERE (SELECT COUNT(*) FROM s WHERE s.u = ?) < 5",
      ),
    ).toBe(true);
    // A plain mutation with neither is not this shape.
    expect(
      hasStructurallyBoundedResult("UPDATE t SET a = 1 WHERE id = ?"),
    ).toBe(false);
  });

  // A table named with a quoted identifier resolved to nothing, so its SCAN
  // was skipped: a miss in table resolution is an exemption, not a no-op.
  it("SCAN rule resolves quoted table names and aliases", async () => {
    await env.DB.exec(
      'CREATE TABLE "lint_quoted" (id INTEGER PRIMARY KEY, name TEXT)',
    );
    try {
      const ctx = {
        userTableNames: new Set(["lint_quoted"]),
        partialIndexNames: new Set<string>(),
        modeledIndexRows: new Map<string, number>(),
        parentRowCounts: new Map<string, number>(),
      };
      for (const sql of [
        'SELECT q.id FROM "lint_quoted" q WHERE q.name = ?',
        "SELECT [q].id FROM [lint_quoted] AS [q] WHERE [q].name = ?",
        "SELECT id FROM `lint_quoted` WHERE name = ?",
      ]) {
        const findings = qScanFindings(
          "QUOTED",
          sql,
          await planOf(sql, "x"),
          ctx,
        );
        expect(
          findings.map((f) => [f.rule, f.table]),
          sql,
        ).toEqual([["no-scan-on-user-tables", "lint_quoted"]]);
      }
    } finally {
      await env.DB.exec('DROP TABLE "lint_quoted"');
    }
  });

  // `GROUP BY` is an exemption from the key groups, so a match must be the
  // clause itself, never words inside a literal or a comment.
  it("a GROUP BY inside a literal or comment keeps an aggregate in scope", () => {
    for (const sql of [
      "SELECT COUNT(*) FROM t WHERE note = 'GROUP BY'",
      "SELECT COUNT(*) FROM t -- GROUP BY u\nWHERE u = ?",
      "SELECT COUNT(*) FROM t /* GROUP BY u */ WHERE u = ?",
      "SELECT COUNT(*) FROM t WHERE note = 'it''s GROUP BY'",
    ]) {
      expect(hasStructurallyBoundedResult(sql), sql).toBe(true);
    }
    expect(
      hasStructurallyBoundedResult(
        "SELECT u, COUNT(*) FROM t WHERE note = 'x' GROUP BY u",
      ),
    ).toBe(false);
  });

  // SQLite's UNIQUE admits any number of rows sharing a key that holds a NULL,
  // and D1 prints `b_id IS NULL` as `b_id=?`, so a fully matched nullable key
  // is pinned only when the statement has no IS comparison.
  it("a fully matched UNIQUE key with a nullable column is pinned only without IS", async () => {
    await env.DB.exec(
      "CREATE TABLE lint_pairs (id INTEGER PRIMARY KEY, a_id INTEGER NOT NULL, b_id INTEGER)",
    );
    await env.DB.exec(
      "CREATE UNIQUE INDEX lint_uniq_pair ON lint_pairs(a_id, b_id)",
    );
    try {
      const ctx = (nullable: boolean): KeyGroupContext => ({
        userTableNames: new Set(["lint_pairs"]),
        uniqueIndexNames: new Set(["lint_uniq_pair"]),
        partialIndexPredicates: new Map(),
        nullableKeyIndexNames: new Set(nullable ? ["lint_uniq_pair"] : []),
        indexNamedColumnCounts: new Map([["lint_uniq_pair", 2]]),
      });
      const isNull =
        "SELECT COUNT(*) FROM lint_pairs WHERE a_id = ? AND b_id IS NULL";
      const equal =
        "SELECT COUNT(*) FROM lint_pairs WHERE a_id = ? AND b_id = ?";
      const isNullPlan = await planOf(isNull, 1);
      const equalPlan = await planOf(equal, 1, 2);
      expect(isNullPlan.map((r) => r.detail)).toEqual(
        equalPlan.map((r) => r.detail),
      );

      expect(qKeyGroups(isNull, isNullPlan, ctx(true)).map(keyGroupId)).toEqual(
        ["lint_pairs | lint_uniq_pair | (a_id=? AND b_id=?)"],
      );
      expect(qKeyGroups(equal, equalPlan, ctx(true))).toEqual([]);
      // Every IS-family spelling reaches a NULL-holding key while printing as
      // an equality, so each keeps the group.
      for (const spelling of [
        "SELECT COUNT(*) FROM lint_pairs WHERE a_id = ? AND b_id ISNULL",
        "SELECT COUNT(*) FROM lint_pairs WHERE a_id = ? AND b_id IS NOT DISTINCT FROM ?",
        "SELECT COUNT(*) FROM lint_pairs WHERE a_id = ? AND b_id IS ?",
      ]) {
        const plan = await planOf(
          spelling,
          ...(spelling.endsWith("?") ? [1, 2] : [1]),
        );
        expect(qKeyGroups(spelling, plan, ctx(true)), spelling).toHaveLength(1);
      }
      expect(qKeyGroups(isNull, isNullPlan, ctx(false))).toEqual([]);
    } finally {
      await env.DB.exec("DROP TABLE lint_pairs");
    }
  });
});
