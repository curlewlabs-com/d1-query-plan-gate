// The database surface every mechanism in this package reads through: the
// subset of Cloudflare D1's binding API they call. `env.DB` in the Workers
// test runtime satisfies it structurally, so no adapter sits between a test
// and D1's own engine, which is the engine whose plans the gate is about.

export interface PlanStatement {
  bind(...values: unknown[]): PlanStatement;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

export interface PlanDatabase {
  prepare(sql: string): PlanStatement;
  batch<T = Record<string, unknown>>(
    statements: PlanStatement[],
  ): Promise<{ results: T[] }[]>;
}

// One row of EXPLAIN QUERY PLAN. `id` and `parent` are present on every row
// SQLite emits; the lint reads only `detail`, so fixtures may omit the rest.
export interface PlanRow {
  id?: number;
  parent?: number;
  detail: string;
}

// A statement to plan. EXPLAIN QUERY PLAN must prepare it, and D1 refuses a
// statement with unbound parameters, so its `bindCount` positional `?`
// parameters are bound with a placeholder value. A value can change the plan -
// SQLite seeks an index for `name GLOB ?` bound to "x*" and scans for "*x" -
// and the placeholder plans such a statement as the seek; README.md sec.
// "Limits" says so.
export interface PlanQuery {
  readonly sql: string;
  readonly bindCount?: number;
}

export type NamedQuery = readonly [name: string, query: PlanQuery];

const PLACEHOLDER_BIND = "x";

// Every EXPLAIN this package issues carries a text no earlier one carried.
// D1 in the Workers test runtime reuses a prepared statement by its SQL text,
// and a reused EXPLAIN keeps answering with the plan it was prepared under
// after a schema change that only REMOVES an index - DROP INDEX, or the table
// dropped and recreated without it - while adding an index does re-plan it. A
// sweep against the schema after such a delta would report the predecessor's
// plan and miss the move. The comment changes the text and nothing SQLite
// plans.
let explainSequence = 0;

// The EXPLAIN text and placeholder binds for one query, for a caller that
// prepares the statement on its own binding (to keep D1's statement type);
// explainStatement is this prepared on a PlanDatabase.
export function explainSql(query: PlanQuery): {
  sql: string;
  binds: string[];
} {
  explainSequence += 1;
  return {
    sql: `EXPLAIN QUERY PLAN /* plan ${explainSequence} */ ${query.sql}`,
    binds: Array.from({ length: query.bindCount ?? 0 }, () => PLACEHOLDER_BIND),
  };
}

export function explainStatement(
  db: PlanDatabase,
  query: PlanQuery,
): PlanStatement {
  const { sql, binds } = explainSql(query);
  return db.prepare(sql).bind(...binds);
}

// Every query's plan rows in one round trip. Issued one EXPLAIN at a time the
// walk costs a round trip per query, and on a loaded CI host the round trip,
// not the planning, is what dominates. A batch runs its statements in order and
// returns their results in that order, so the plans are the same plans.
// Plans are keyed by name, so a second query under a name already taken would
// replace the first one's plan - and hide a broken query, or its move, behind
// a working one. Every sweep refuses that up front.
export function assertUniqueNames(queries: readonly NamedQuery[]): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const [name] of queries) {
    if (seen.has(name)) duplicates.add(name);
    seen.add(name);
  }
  if (duplicates.size > 0) {
    throw new Error(
      `d1-query-plan-gate: query names must be unique; repeated: ${[...duplicates].sort().join(", ")}`,
    );
  }
}

export async function explainAll(
  db: PlanDatabase,
  queries: readonly NamedQuery[],
): Promise<Map<string, PlanRow[]>> {
  assertUniqueNames(queries);
  const plans = await db.batch<PlanRow>(
    queries.map(([, query]) => explainStatement(db, query)),
  );
  return new Map(
    queries.map(([name], i) => {
      const plan = plans[i];
      if (plan === undefined) {
        throw new Error(
          `d1-query-plan-gate: the batch returned no result for "${name}"`,
        );
      }
      return [name, plan.results];
    }),
  );
}
