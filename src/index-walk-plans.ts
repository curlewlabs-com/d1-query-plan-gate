// Reads a registry's plan rows and the corresponding SQLite programs on the
// same D1 schema. Keeping each filter list on its own plan row distinguishes
// repeated seeks on one index within a single statement.

import {
  explainAll,
  explainText,
  type NamedQuery,
  type PlanDatabase,
  type PlanRow,
} from "./database";
import {
  indexSeeks,
  residualByPlanRow,
  type BytecodeContext,
} from "./residual-walks";
import type { BytecodeRow } from "./sqlite-opcodes";

export interface IndexWalkPlanRow extends PlanRow {
  // Absent on other plan nodes. An empty array means a paired index walk
  // with no recognized post-seek filter.
  residual?: readonly string[];
}

async function readContext(db: PlanDatabase): Promise<BytecodeContext> {
  // Column opcodes address physical slots. index_xinfo includes auxiliary
  // primary-key fields on WITHOUT ROWID indexes and gives the table itself
  // in primary-key storage order. Rowid tables omit virtual generated fields.
  const { results } = await db
    .prepare(
      `
    WITH objects AS (
      SELECT m.name, m.type, m.tbl_name, m.rootpage, t.wr
      FROM sqlite_master m JOIN pragma_table_list t ON t.name = m.tbl_name
      WHERE t.schema = 'main' AND t.type = 'table' AND m.rootpage > 0
        AND m.tbl_name NOT GLOB 'sqlite_*' AND m.tbl_name NOT GLOB '_cf_*'
        AND m.tbl_name NOT GLOB 'd1_*'
    )
    SELECT o.*, c.cid AS slot, c.name AS col, 0 AS pk FROM objects o
    CROSS JOIN pragma_table_xinfo(o.name) c
    WHERE o.type = 'table' AND o.wr = 0 AND c.hidden != 2
    UNION ALL
    SELECT o.*, c.seqno AS slot, CASE WHEN c.cid = -1 THEN 'rowid' ELSE c.name END AS col,
      o.type = 'table' AND c.key AS pk
    FROM objects o CROSS JOIN pragma_index_xinfo(o.name) c
    WHERE o.type = 'index' OR o.wr = 1
    ORDER BY rootpage, slot
  `,
    )
    .all<{
      name: string;
      type: "table" | "index";
      tbl_name: string;
      rootpage: number;
      pk: number;
      col: string | null;
    }>();
  const objectsByRootPage = new Map<
    number,
    { name: string; type: "table" | "index"; table: string }
  >();
  const primaryKeyWidths = new Map<string, number>();
  const columnsByObject = new Map<string, (string | null)[]>();
  for (const row of results) {
    let columns = columnsByObject.get(row.name);
    if (columns === undefined) {
      columns = [];
      columnsByObject.set(row.name, columns);
      objectsByRootPage.set(row.rootpage, {
        name: row.name,
        type: row.type,
        table: row.tbl_name,
      });
    }
    columns.push(row.col);
    if (row.pk) primaryKeyWidths.set(row.name, columns.length);
  }
  return { objectsByRootPage, columnsByObject, primaryKeyWidths };
}

export async function explainIndexWalks(
  db: PlanDatabase,
  queries: readonly NamedQuery[],
): Promise<Map<string, IndexWalkPlanRow[]>> {
  if (queries.length === 0) return new Map();
  const plans = await explainAll(db, queries);
  const context = await readContext(db);
  const programs = await db.batch<BytecodeRow>(
    queries.map(([, query]) => {
      const { sql, binds } = explainText(query, "EXPLAIN");
      return db.prepare(sql).bind(...binds);
    }),
  );
  return new Map(
    queries.map(([name], i) => {
      const plan = plans.get(name);
      if (!plan) throw new Error(`d1-query-plan-gate: no plan for "${name}"`);
      const program = programs[i];
      if (!program?.results.length)
        throw new Error(`d1-query-plan-gate: no bytecode for "${name}"`);
      const filters = residualByPlanRow(
        name,
        plan,
        indexSeeks(program.results, context),
      );
      return [
        name,
        plan.map((row) => {
          const residual = filters.get(row);
          return residual === undefined ? row : { ...row, residual };
        }),
      ];
    }),
  );
}
