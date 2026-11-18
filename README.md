# d1-query-plan-gate

## What it is

A TypeScript library for test suites that run against
[Cloudflare D1](https://developers.cloudflare.com/d1/) in the Workers test
runtime (`@cloudflare/vitest-plugin`). It holds the SQLite query plans your
application will run to what a reviewer has read, with three mechanisms:

- **Plan moves per schema delta.** `EXPLAIN QUERY PLAN` every named statement
  against the previous schema and against the current one, and require the set
  of plans that differ to equal a committed, generated table. A schema change
  that re-points a query at a different index puts that plan pair in the pull
  request's diff.
- **A plan lint.** Read each statement's plan and flag a SCAN of a table the
  statement names, a SCAN riding a partial index that is not an order of
  magnitude smaller than its table, and an index range seek with only an upper
  bound (which walks to the oldest surviving row). It also extracts the key
  groups a bounded-result statement seeks, for a reviewed roster.
- **Production-shape statistics.** Turn a cardinality model (row counts per
  table, stat strings for the indexes that need one) into `sqlite_stat1` rows,
  seed them into the test database so the planner chooses as it would in
  production, and render the same rows as an idempotent SQL payload for the
  live database.

It has no runtime dependencies. The database is passed in as an interface D1's
`D1Database` already satisfies.

## Why it exists

SQLite picks a plan from the schema and the statistics, and nothing in a typical
review shows the plan. Three things go wrong silently:

- **An index changes plans nobody edited.** Adding one re-points existing
  queries at it the moment it exists, with no change to their SQL or their
  results. Usually that is an improvement; sometimes the new index is a partial
  whose predicate leaves a residual filter, or a key order that sends an
  `ORDER BY` to a temp B-tree, and the first sign is production latency.
- **Empty test tables plan differently from production.** With no statistics,
  the planner uses its default estimates, so the plan a test sees is not the
  plan production runs. Statistics have to be seeded for the plan to mean
  anything.
- **Plans depend on the engine build.** Two SQLite builds given the same schema
  and statistics can choose different plans. Comparing plans on a host
  `sqlite3` says little about D1. This package measures on `env.DB`, which is
  D1's own engine in the test runtime.

[`sqlite-plan-diff`](https://github.com/superboxes/sqlite-plan-diff), for
example, compares one query at a time on a host SQLite file. This package compares a whole registry of statements across two schemas, on D1, and
keys each acknowledgement on the exact plan pair, so any later change to an
acknowledged plan (an edited query, recalibrated statistics, a runtime upgrade
carrying a new SQLite) fails until someone reads it again.

## How to use it

The package is `@curlewlabs-com/d1-query-plan-gate`. It is not on the npm
registry: install it from the GitHub release tarball, with an exact pin:

```sh
bun add https://github.com/curlewlabs-com/d1-query-plan-gate/releases/download/v0.4.0/curlewlabs-com-d1-query-plan-gate-0.4.0.tgz
```

The package ships TypeScript sources; Vitest, Wrangler and Bun compile them.
Your test project needs `@cloudflare/vitest-plugin` and a D1 binding.

### 1. A cardinality model and seeded statistics

```ts
// schema/stats-model.ts
import type { CardinalityModel } from "@curlewlabs-com/d1-query-plan-gate";

export const MODEL: CardinalityModel = {
  tables: { users: 25_000, events: 5_000_000, meta: 1 },
  indexes: {
    // "<rows> <avg rows per distinct user_id> <avg per (user_id, sent_at)>"
    idx_events_user_sent: "5000000 200 1",
  },
};
```

```ts
// in a test setup, after applying the schema
import { env } from "cloudflare:test";
import { applyProductionStats } from "@curlewlabs-com/d1-query-plan-gate";
import { MODEL } from "../schema/stats-model";

await applyProductionStats(env.DB, MODEL);
```

Every user table must appear in `tables`: a table the model does not know
throws, rather than planning at the default heuristic while the rest of the
suite claims production shape. An index absent from `indexes` gets
`"<table rows> 1 ... 1"`, one `1` per key column (each key prefix assumed
unique), and every table also gets a table-level row with its count, which is
what a table whose indexes are all partial plans from. A WITHOUT ROWID table's primary key is an index too, which
SQLite records under the table's own name, so `indexes` keys it by the table
name; `applyProductionStats` finds it from `pragma_table_list`, and a caller
enumerating indexes itself for `buildSqliteStat1Rows` passes each index's key
width as `columns` (the row count of `pragma_index_info`), and a WITHOUT ROWID
key as `{ name: table, tbl_name: table, columns: <primary-key columns> }`.

For the live database, render the same rows as a payload and apply it at
deploy time (`wrangler d1 execute --file`):

```ts
import {
  buildSqliteStat1Rows,
  renderStatsSql,
} from "@curlewlabs-com/d1-query-plan-gate";

const sql = renderStatsSql(buildSqliteStat1Rows(MODEL, tables, indexes), {
  header: ["-- Generated from schema/stats-model.ts; do not edit."],
  bootstrapTable: "meta", // any small table; see below
});
```

The payload analyzes only `bootstrapTable` to bring `sqlite_stat1` into
existence, then deletes and rewrites it, then runs `ANALYZE sqlite_master` so
the planner reloads. A bare `ANALYZE` would scan every table and index of the
live database for statistics the payload immediately replaces.

**Testing your statistics fixture: poison and revert.** To prove the seed
steers the planner, write extreme synthetic rows into `sqlite_stat1` (say
`1000 1` against `10000000 1000000 1`) that force the planner onto the other
index, run `ANALYZE sqlite_master`, then call `applyProductionStats` and assert
the plan comes back to the production-shape choice. Do not compare a database
with no statistics against a seeded one instead: both plans rest on row-format
cost estimates that shift whenever a column is added, and they can converge on
the same plan by accident and hide a broken fixture.

### 2. The plan lint

```ts
import { env } from "cloudflare:test";
import {
  explainAll,
  qRangeSearchFindings,
  qScanFindings,
  type ScanRuleContext,
} from "@curlewlabs-com/d1-query-plan-gate";

const queries = [
  [
    "EVENTS_FOR_USER",
    {
      sql: "SELECT id FROM events WHERE user_id = ? AND sent_at > ?",
      bindCount: 2,
    },
  ],
] as const;

const plans = await explainAll(env.DB, queries);
const stat = await env.DB.prepare(
  "SELECT idx, stat FROM sqlite_stat1 WHERE idx IS NOT NULL",
).all<{ idx: string; stat: string }>();
const ctx: ScanRuleContext = {
  userTableNames: new Set(Object.keys(MODEL.tables)),
  partialIndexNames: new Set(["idx_events_unsent"]), // indexes with a WHERE
  modeledIndexRows: new Map(
    stat.results.map((r) => [r.idx, Number(r.stat.split(" ")[0])]),
  ),
  parentRowCounts: new Map(Object.entries(MODEL.tables)),
};

const findings = queries.flatMap(([name, q]) => [
  ...qScanFindings(name, q.sql, plans.get(name)!, ctx),
  ...qRangeSearchFindings(name, q.sql, plans.get(name)!, ctx),
]);
// Subtract your audited exceptions, keyed by (rule, table, index, q), then
// expect what remains to be empty.
```

The rule ids are `no-scan-on-user-tables`, `no-unbounded-partial-index` and
`no-unbounded-range-search`. Only tables the statement's SQL names count, so
the foreign-key probes SQLite plans for a parent-table write are not findings.
The range rule skips `DELETE` and `UPDATE`: a retention sweep seeks the old end
of a table on purpose.

A statement's `bindCount` parameters are bound with a placeholder (see
Limits). Names must be unique; a sweep refuses a repeated one.

The parser reads the plan-row shapes D1 prints and **throws** on any SEARCH row
or constraint term it does not recognize, because a skipped row would read as
"fine". A new shape after a runtime upgrade fails your suite naming the row.

`qKeyGroups` and `keyGroupId` give the index key groups a statement with a
structurally bounded result (a literal `LIMIT`, or an aggregate without
`GROUP BY`) seeks. A plan cannot say how large a group is, so hold the ids
against a committed roster in which each entry says why its group is bounded.
A UNIQUE index whose key is fully matched counts as one row and is left out,
except an index named in `nullableKeyIndexNames` when the statement uses an
`IS` comparison: SQLite's UNIQUE admits repeated keys holding a NULL, and the
plan prints `b_id IS NULL` as `b_id=?`.

### 3. Plan moves per schema delta

Keep the previous release's schema beside the current one, and a generated
table of the moves a reviewer has read:

```ts
import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import {
  acknowledgementDrift,
  measuredMoves,
  movedQueries,
  planSweep,
  renderPlanMovesModule,
  unplannableQueries,
} from "@curlewlabs-com/d1-query-plan-gate";
import { PLAN_MOVES } from "../schema/plan-moves.generated";

it("moves exactly the plans schema/plan-moves.generated.ts holds", async () => {
  await resetTo(predecessorSql); // your own: drop tables, apply DDL, seed stats
  const before = await planSweep(env.DB, queries);
  await resetTo(schemaSql);
  const after = await planSweep(env.DB, queries);

  expect(unplannableQueries(after)).toEqual([]);
  const measured = measuredMoves(movedQueries(before, after), before, after);
  await expect(
    renderPlanMovesModule(measured, {
      preamble:
        "// Generated by test/plan-delta.test.ts; run it with -u to rewrite.\n" +
        'import type { PlanMove } from "@curlewlabs-com/d1-query-plan-gate";\n',
    }),
    JSON.stringify(acknowledgementDrift(measured, PLAN_MOVES)),
  ).toMatchFileSnapshot("../schema/plan-moves.generated.ts");
});
```

Run it with `vitest -u` to accept the moves; the regenerated file's diff is what
the reviewer reads. Seed both sides from the same cardinality model, so a
difference is attributable to the schema and nothing else, but build each
side's rows against that side's own schema: call `applyProductionStats` after
each `resetTo`, with `indexes` filtered to the indexes that side holds (and
`tables` covering every table it holds). Do not apply one rendered payload to
both: SQLite reads a `sqlite_stat1` row naming an index the schema lacks as the
table's row count, so a partial index the delta adds would set its table's
count on the predecessor side. A statement that
cannot be prepared against the previous schema (it reads a column the delta
adds) records its error in place of a plan, which counts as a move; one that
cannot be prepared against the current schema is broken, which
`unplannableQueries` reports.

Plans are rendered as a parent-indented tree without SQLite's VDBE addresses,
which shift whenever a statement's program grows (any write to a table gains
index-maintenance code when an index is added) without its rows being found
any differently.

## Limits

- Tested on D1 in the Workers test runtime only. Any database object with the
  same `prepare`/`bind`/`all`/`run`/`batch` shape will run, but plan text and
  error messages are D1's, and nothing else is tested.
- **The lint reads table bindings from the SQL text, not from SQLite.** It
  matches the statement's text to learn which tables a plan row is about, and
  it reads these shapes correctly:
  - a table named directly after `FROM`, `JOIN`, `INTO` or `UPDATE`, bare or
    quoted (`"t"`, `` `t` ``, `[t]`), spelled as the schema spells it;
  - an alias written right after such a table in a `FROM` or `JOIN` source,
    with or without `AS`, used once in the statement;
  - plan rows that name such a table or alias, or a subquery or CTE source;
  - table and index names of word characters (`[A-Za-z0-9_]`).

  Outside those shapes a plan row can be skipped or attributed to the wrong
  table, and either can hide a finding. That includes, at least: the second
  and later tables of a comma-separated `FROM` list; a parenthesized table
  (`FROM (t) x`); a name in a different case, schema-qualified (`main.t`) or
  single-quoted (`'t'`); an alias reused for different tables in different
  scopes, or one that is a keyword SQLite allows as a name; `FROM`/`JOIN` text
  inside a comment or string literal, which is read as SQL; and an index name
  with other characters, which the SCAN rule reads as its leading word
  characters. A `GROUP BY` inside a subquery, or inside a literal or comment,
  takes the whole statement out of the key groups. Keep the SQL you lint in
  the shapes above - a query builder's output usually is - or check that the
  plan rows you rely on resolve to the right tables.

- **Mutations are outside the range rule, subqueries included.** A retention
  sweep seeks the old end of its table on purpose, as often through a subquery
  (`DELETE ... WHERE id IN (SELECT id ... WHERE ts < ? LIMIT n)`) as directly,
  so the rule skips every statement starting with `DELETE` or `UPDATE`. An
  unbounded read inside a mutation needs a measured rows-read budget instead.
- **Plans are measured with placeholder binds.** A value can change the plan:
  `name GLOB ?` seeks an index for `"x*"` and scans for `"*x"`, and the
  placeholder plans it as the seek. A statement whose plan depends on its
  values is checked by a test of its own, with those values.
- **One statistics payload is for one schema.** SQLite reads a `sqlite_stat1`
  row naming an index the schema lacks as the table's row count, so
  `renderStatsSql` output applied to a different schema - the predecessor side
  of a plan-delta sweep - can set a table's count from a new index's stat. The
  recipe under "How to use it" builds each side against its own schema.
- `sqlite_stat4` is not available on D1, so range-distribution-aware choices
  are out of reach; the planner works from `sqlite_stat1` row counts.
- The lint reads what the plan prints. A residual filter on a column outside
  the chosen index, or a lower bound against a fixed constant rather than a
  moving window, is invisible to it; only a measured rows-read budget catches
  those.
- Version 0.x carries no compatibility promise between minor versions.

## License

Licensed under either of

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))
- MIT license ([LICENSE-MIT](LICENSE-MIT))

at your option. Releases published under the MIT license alone may also be used
under either license.

### Contribution

Unless you explicitly state otherwise, any contribution intentionally submitted
for inclusion in this project by you, as defined in the Apache-2.0 license,
shall be dual licensed as above, without any additional terms or conditions.
