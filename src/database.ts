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

// A statement to plan. `bindCount` positional `?` parameters are bound with a
// placeholder value, because EXPLAIN QUERY PLAN must prepare the statement and
// D1 refuses to run one with unbound parameters; the plan does not depend on
// the value.
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

export function explainStatement(
  db: PlanDatabase,
  query: PlanQuery,
): PlanStatement {
  const binds = Array.from(
    { length: query.bindCount ?? 0 },
    () => PLACEHOLDER_BIND,
  );
  explainSequence += 1;
  return db
    .prepare(`EXPLAIN QUERY PLAN /* plan ${explainSequence} */ ${query.sql}`)
    .bind(...binds);
}

// Every query's plan rows in one round trip. Issued one EXPLAIN at a time the
// walk costs a round trip per query, and on a loaded CI host the round trip,
// not the planning, is what dominates. A batch runs its statements in order and
// returns their results in that order, so the plans are the same plans.
export async function explainAll(
  db: PlanDatabase,
  queries: readonly NamedQuery[],
): Promise<Map<string, PlanRow[]>> {
  const plans = await db.batch<PlanRow>(
    queries.map(([, query]) => explainStatement(db, query)),
  );
  return new Map(queries.map(([name], i) => [name, plans[i]!.results]));
}
