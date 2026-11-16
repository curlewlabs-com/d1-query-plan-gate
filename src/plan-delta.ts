// Plan moves per schema delta: which query plans a schema change moves, and
// whether that set matches the table a reviewer has read.
//
// Adding an index re-points existing queries at it the moment it exists, with
// no edit to their SQL and no change to their result sets. A lint that fails a
// SCAN or an unbounded seek does not see that: one bounded equality seek
// swapping index is neither. So the gate EXPLAINs every query twice, once
// against the predecessor schema and once against the current one, and the
// plan pairs that differ must equal a committed table byte for byte. The table
// is regenerated, never hand-edited, and its diff is what a reviewer reads.
//
// The move is usually an improvement. The table exists for the other
// direction - a partial index whose predicate leaves a residual filter, a key
// order that drops an ORDER BY into a temp B-tree - which would otherwise first
// surface as production latency or rows read.
//
// MEASURE ON THE ENGINE PRODUCTION RUNS. Plan choice is planner-version
// specific: separate SQLite builds on one machine, given the same schema and
// statistics, have chosen different plans for one compound query. The SET of
// moved queries survived that; the per-query plan text, which is what the
// table compares, did not. The same holds for the engine itself: a runtime
// upgrade that carries a new SQLite can rewrite an acknowledged plan, and that
// failure is the gate working - the plan production will run changed.

import {
  assertUniqueNames,
  explainStatement,
  type NamedQuery,
  type PlanDatabase,
  type PlanQuery,
  type PlanRow,
} from "./database";

// One acknowledged plan pair, one array element per rendered plan line. Keyed
// on the pair rather than the name alone: an entry holding only the name would
// carry its acknowledgement over to any later plan for that query, which nobody
// reviewed. Whatever moves a listed plan - an index revised mid-delta, an edit
// to the query, recalibrated statistics, a planner upgrade - fails the gate
// until a regeneration puts the new pair in a diff. A query with no plan
// against the predecessor records why in `before`.
export interface PlanMove {
  readonly before: readonly string[];
  readonly after: readonly string[];
}

// Recorded in place of a plan when the SQL cannot even be prepared against the
// schema under test. On the predecessor side that is a real answer - a query
// reading a column the delta adds has no pre-delta plan - and it registers as a
// move. On the current side it is a broken query, which the caller asserts
// against (`unplannableQueries`).
export const UNPLANNABLE = "<unplannable:";

// Why the query cannot be planned is part of what an acknowledgement read, and
// where in the SQL that was found is not: the offset moves with any edit to the
// query's column list, which would demand a fresh read of a pair the edit left
// as it was. The pattern is deliberately this narrow, so a message it does not
// recognize keeps its offset and over-reports rather than merging distinct
// reasons.
const PREPARE_ERROR_OFFSET = / at offset \d+/;

// EXPLAIN QUERY PLAN's id/parent are VDBE addresses, so they shift whenever the
// generated program grows - every write statement against an indexed table
// gains index-maintenance code the moment a delta adds an index, while finding
// its rows exactly as before. Rendering the rows as the parent-indented tree
// the addresses encode keeps the nesting and drops the addresses; keyed on the
// raw rows instead, a delta reports untouched writes alongside the reads whose
// seeks really moved.
export function renderPlan(rows: readonly PlanRow[]): string {
  const parentOf = new Map(rows.map((row) => [row.id ?? 0, row.parent ?? 0]));
  return rows
    .map((row) => {
      let depth = 0;
      let parent = row.parent ?? 0;
      // The root is id 0, which is never a row. Bounded by the row count so a
      // parent chain that somehow cycles stops rather than hangs.
      while (parent !== 0 && depth <= rows.length) {
        parent = parentOf.get(parent) ?? 0;
        depth += 1;
      }
      return `${"  ".repeat(depth)}${row.detail}`;
    })
    .join("\n");
}

async function planOf(db: PlanDatabase, query: PlanQuery): Promise<string> {
  // Only the prepare is in the try: building the statement and rendering the
  // rows fail for authoring reasons, not for the schema-mismatch reason
  // UNPLANNABLE reports, and would be misread as one from inside it.
  const statement = explainStatement(db, query);
  let rows: PlanRow[];
  try {
    rows = (await statement.all<PlanRow>()).results ?? [];
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return `${UNPLANNABLE} ${reason.replace(PREPARE_ERROR_OFFSET, "")}>`;
  }
  return renderPlan(rows);
}

// The rendered plan of every query against the schema the database holds now.
// The caller applies the schema (and any statistics) first, because how to
// reset a database to a given schema - drop order, retired tables, seed rows -
// is the caller's knowledge.
//
// One round trip for the whole sweep. The per-query walk below is the
// DIAGNOSIS path, not a retry. A batch is a transaction: one statement that
// cannot prepare aborts the whole thing, and D1's error names the SQL rather
// than which member produced it - so the walk is what turns a whole-batch abort
// back into UNPLANNABLE against the query's own name. It runs on the
// predecessor side whenever the delta adds a column some query reads, which is
// the expected answer there, and on the current side only when a query is
// broken. Discarding the batch's own error is safe because the walk re-derives
// it attributed; a batch that failed for any other reason lands on the same
// answer more slowly.
//
// Only the batch is inside the try, for the reason planOf states.
export async function planSweep(
  db: PlanDatabase,
  queries: readonly NamedQuery[],
): Promise<Map<string, string>> {
  assertUniqueNames(queries);
  const explains = queries.map(([, query]) => explainStatement(db, query));
  let batched: { results: PlanRow[] }[] | null = null;
  try {
    batched = await db.batch<PlanRow>(explains);
  } catch {
    // Left null: the per-query walk below names the offender.
  }
  if (batched !== null) {
    const results = batched;
    return new Map(
      queries.map(([name], i) => [name, renderPlan(results[i]!.results)]),
    );
  }
  const plans = new Map<string, string>();
  for (const [name, query] of queries) {
    plans.set(name, await planOf(db, query));
  }
  return plans;
}

// The queries a sweep could not prepare, as `name: reason` lines. Against the
// current schema this must be empty: a query that cannot be prepared there is
// broken, not moved - and left unasserted it would cancel out whenever the
// predecessor rejects it too, hiding each half behind an empty diff.
export function unplannableQueries(
  plans: ReadonlyMap<string, string>,
): string[] {
  return [...plans]
    .filter(([, plan]) => plan.startsWith(UNPLANNABLE))
    .map(([name, plan]) => `${name}: ${plan}`);
}

// Over the predecessor's names and the target's together, not just one side's:
// a one-sided walk would report nothing for a name only one of them holds,
// which is the direction a reader would never think to check.
export function movedQueries(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): string[] {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names].filter((n) => before.get(n) !== after.get(n)).sort();
}

export function measuredMoves(
  names: readonly string[],
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): Record<string, PlanMove> {
  return Object.fromEntries(
    names.map((name) => [
      name,
      {
        before: (before.get(name) ?? "").split("\n"),
        after: (after.get(name) ?? "").split("\n"),
      },
    ]),
  );
}

export interface AcknowledgementDrift {
  unacknowledged: string[];
  stale: string[];
  changed: string[];
}

// What a failure message names. A comparison of the rendered table already
// fails on any difference; this tells the reader which queries to read.
// `changed` is what a comparison of names alone cannot see: the query is still
// in the moved set and still in the table, and the plan the entry vouches for
// is no longer the plan.
export function acknowledgementDrift(
  measured: Readonly<Record<string, PlanMove>>,
  acknowledged: Readonly<Record<string, PlanMove>>,
): AcknowledgementDrift {
  const measuredNames = Object.keys(measured).sort();
  const acknowledgedNames = Object.keys(acknowledged).sort();
  return {
    unacknowledged: measuredNames.filter(
      (n) => !Object.hasOwn(acknowledged, n),
    ),
    stale: acknowledgedNames.filter((n) => !Object.hasOwn(measured, n)),
    changed: measuredNames.filter(
      (n) =>
        Object.hasOwn(acknowledged, n) &&
        JSON.stringify(measured[n]) !== JSON.stringify(acknowledged[n]),
    ),
  };
}

export interface PlanMovesModuleOptions {
  // Everything above the export line, verbatim: a header comment saying how to
  // regenerate the file, and an import that brings the `PlanMove` type into
  // scope under that name. The table is exported as `PLAN_MOVES`.
  readonly preamble: string;
}

// The whole generated module, so a comparison against the committed file is
// exact: an entry edited by hand, or anything authored added beside the table,
// fails like a stale entry does.
export function renderPlanMovesModule(
  measured: Readonly<Record<string, PlanMove>>,
  options: PlanMovesModuleOptions,
): string {
  return `${options.preamble}
export const PLAN_MOVES: Readonly<Record<string, PlanMove>> = ${JSON.stringify(measured, null, 2)};
`;
}

export interface PlanPairLabels {
  readonly before: string;
  readonly after: string;
}

// Each named query's plan on both sides, for a failure message.
export function formatPlanPairs(
  names: readonly string[],
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
  labels: PlanPairLabels,
): string {
  return names
    .map(
      (name) =>
        `--- ${name}\n${labels.before}:\n${before.get(name)}\n${labels.after}:\n${after.get(name)}`,
    )
    .join("\n\n");
}
