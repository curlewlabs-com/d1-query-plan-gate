// The plan lint: classifies SQLite EXPLAIN QUERY PLAN rows for the SCAN and
// unbounded-range rules, and extracts the key groups a bounded-result
// statement seeks. The caller supplies the table and index universe and the
// modeled cardinalities; this module owns the parsing and the
// bounded-working-set decisions.
//
// Rules, by the id a finding carries:
//
//   no-scan-on-user-tables      a SCAN of a table the statement names
//   no-unbounded-partial-index  a SCAN riding a partial index that is not an
//                               order of magnitude smaller than its table
//   no-unbounded-range-search   an upper-bound-only range SEARCH, which walks
//                               to the oldest surviving row
//
// A finding is a candidate, not a verdict: the caller subtracts its own
// audited exceptions, keyed by (rule, table, index, query).

import type { PlanRow } from "./database";

export type PlanLintRule =
  | "no-scan-on-user-tables"
  | "no-unbounded-partial-index"
  | "no-unbounded-range-search";

export interface QueryPlanFinding {
  rule: PlanLintRule;
  table: string;
  index?: string;
  q?: string;
  detail: string;
}

// A partial index only earns the SCAN exemption if it bounds the in-flight
// set: its modeled row count must be at least an order of magnitude below the
// parent table. A partial whose WHERE matches most of the table - a lifecycle
// gate that rarely flips, so most rows sit in the indexed subset (the textbook
// example is a soft-delete `WHERE archived_at IS NULL` on a table that almost
// never archives) - is walked at SCAN-class cost, so it must NOT be exempt. An
// order of magnitude is the bar because an index that shrinks the scanned set
// by less than 10x is the same cost class as the full scan for a statement run
// every minute; a clean 10x (or better) reduction is bounded. Fail closed: if
// either cardinality is unmodeled the bound cannot be proven, so the exemption
// is denied.
const PARTIAL_INDEX_MIN_REDUCTION = 10;
export function partialIndexBoundsWorkingSet(
  indexName: string,
  table: string,
  modeledIndexRows: ReadonlyMap<string, number>,
  parentRowCounts: ReadonlyMap<string, number>,
): boolean {
  const partialRows = modeledIndexRows.get(indexName);
  const parentRows = parentRowCounts.get(table);
  if (partialRows === undefined || parentRows === undefined) return false;
  // `<=`: a reduction of exactly an order of magnitude counts as bounded,
  // matching "at least an order of magnitude below".
  return partialRows * PARTIAL_INDEX_MIN_REDUCTION <= parentRows;
}

export interface ScanRuleContext {
  // The tables the rules apply to: user tables, not SQLite's or the
  // platform's own.
  userTableNames: ReadonlySet<string>;
  partialIndexNames: ReadonlySet<string>;
  // Each index's modeled row count: the first token of its sqlite_stat1 row.
  modeledIndexRows: ReadonlyMap<string, number>;
  // Each table's modeled row count, from the cardinality model.
  parentRowCounts: ReadonlyMap<string, number>;
}

// SQL keywords that legally follow a table name without an alias.
// `FROM pairs WHERE` -> next token is WHERE, not an alias. The check is
// case-insensitive against this set.
const POST_TABLE_KEYWORDS = new Set([
  "WHERE",
  "ON",
  "USING",
  "LEFT",
  "RIGHT",
  "INNER",
  "OUTER",
  "CROSS",
  "JOIN",
  "GROUP",
  "ORDER",
  "LIMIT",
  "HAVING",
  "SET",
  "VALUES",
]);

// Resolve, from a statement's SQL text, the user tables it names (after
// FROM/JOIN/INTO/UPDATE) and its alias->table map. Shared by the SCAN engine,
// the range-SEARCH engine and the key groups so they read aliases identically -
// a divergence between the parsers would let an aliased plan row slip past one
// rule but not the other.
function resolvePlanTables(
  sql: string,
  userTableNames: ReadonlySet<string>,
): { primaryTables: Set<string>; aliasToTable: Map<string, string> } {
  const tableRefRe = /\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-z_]\w*)/gi;
  const aliasRe =
    /\b(?:FROM|JOIN)\s+([a-z_]\w*)(?:\s+(?:AS\s+)?([a-z_]\w*))?/gi;
  const primaryTables = new Set<string>();
  const aliasToTable = new Map<string, string>();
  let mm: RegExpExecArray | null;
  while ((mm = tableRefRe.exec(sql)) !== null) {
    const candidate = mm[1]!;
    if (userTableNames.has(candidate)) primaryTables.add(candidate);
  }
  let am: RegExpExecArray | null;
  while ((am = aliasRe.exec(sql)) !== null) {
    const tbl = am[1]!;
    if (!userTableNames.has(tbl)) continue;
    const alias = am[2];
    if (!alias) continue;
    if (POST_TABLE_KEYWORDS.has(alias.toUpperCase())) continue;
    aliasToTable.set(alias, tbl);
  }
  return { primaryTables, aliasToTable };
}

// SQLite marks a table it reaches as an EXISTS semi-join between the alias and
// the access path: `SEARCH d EXISTS USING INDEX ...`. Every engine below
// anchors its alias and access path on adjacent tokens, so an unstripped marker
// either drops the row or loses its index. The access path after the marker is
// the walk itself, and an EXISTS probe needs only one matching row, so reading
// it as an ordinary seek never under-prices it.
function planAccessDetail(detail: string): string {
  return detail.replace(/^(SCAN|SEARCH)\s+(\w+)\s+EXISTS\b/, "$1 $2");
}

// One term of a SEARCH row's constraint paren. `column` is `<expr>` for an
// expression-index column, which is how SQLite prints one. `ANY` is a
// skip-scan: the seek visits every distinct value of that leading column, so
// the term bounds nothing.
export interface ConstraintTerm {
  column: string;
  op: "=" | "<" | "<=" | ">" | ">=" | "ANY";
}

// One SEARCH row of EXPLAIN QUERY PLAN, read for the range rule and the key
// groups. `constraint` (the paren's text, kept for the key-group id) and
// `terms` are undefined for an end seek: the MIN/MAX optimization reads one end
// of an index (`SEARCH t USING COVERING INDEX i`) or of the rowid b-tree (bare
// `SEARCH t`), one row with no seek key to classify.
export interface SearchRow {
  target: string;
  method: string | undefined;
  constraint: string | undefined;
  terms: ConstraintTerm[] | undefined;
}

// SQLite publishes the plan only as this detail text, so the shapes are
// enumerated rather than parsed, and a SEARCH row matching none of them THROWS.
// The range rule and the key groups decide by what they find in a row, so a
// row they skip is a verdict of "fine": an unknown token in the head would
// otherwise retire the row from them silently, as the EXISTS marker once did.
// The shapes are the ones live plans print, LEFT-JOIN suffix included; a new
// one fails naming the row, and joins the list once read. The same holds inside
// the paren, term by term: a term the range rule cannot read would otherwise
// leave its range unseen, so `<expr><?` would pass as no range at all. The
// paren nests exactly one construct, a skip-scan's `ANY(col)`.
const SEARCH_SEEK_RE =
  /^SEARCH\s+(\w+)\s+USING\s+(.+?)\s*\(((?:[^()]|\(\w+\))*)\)(?:\s+LEFT-JOIN)?$/;
const CONSTRAINT_TERM_RE = /^(\w+|<expr>)(<=|>=|<|>|=)\?$/;
const SKIP_SCAN_TERM_RE = /^ANY\((\w+)\)$/;

function constraintTerms(constraint: string, detail: string): ConstraintTerm[] {
  return constraint.split(/\s+AND\s+/).map((raw) => {
    const term = raw.trim();
    const comparison = CONSTRAINT_TERM_RE.exec(term);
    if (comparison) {
      return {
        column: comparison[1]!,
        op: comparison[2] as ConstraintTerm["op"],
      };
    }
    const skipScan = SKIP_SCAN_TERM_RE.exec(term);
    if (skipScan) return { column: skipScan[1]!, op: "ANY" };
    throw new Error(
      `d1-query-plan-gate cannot read the constraint term "${term}" in "${detail}"; its shape needs adding to constraintTerms before the range rule or the key groups can classify it`,
    );
  });
}
const SEARCH_END_SEEK_RE =
  /^SEARCH\s+(\w+)(?:\s+USING\s+((?:COVERING\s+)?INDEX\s+\w+))?$/;
// A table-valued function such as json_each walks the value its statement was
// bound with, not a schema table, so the range rule and the key groups have no
// seek key to read in it. That is not a verdict that it is bounded: its bound
// is whatever the caller caps the bound value at, which
// `planVirtualTableSources` lets the caller enumerate and check.
const SEARCH_VIRTUAL_TABLE_RE =
  /^SEARCH\s+(\w+)\s+(VIRTUAL TABLE INDEX\s+\d+:.*)$/;

// The aliases of every virtual-table row a plan walks. SQLite prints such a
// row as SCAN or SEARCH depending on the constraint it hands the module, so
// either form is read.
const VIRTUAL_TABLE_ROW_RE = /^(?:SCAN|SEARCH)\s+(\w+)\s+VIRTUAL TABLE\b/;
export function planVirtualTableSources(plan: readonly PlanRow[]): string[] {
  return plan.flatMap((row) => {
    const match = VIRTUAL_TABLE_ROW_RE.exec(planAccessDetail(row.detail));
    return match ? [match[1]!] : [];
  });
}

export function parseSearchRow(detail: string): SearchRow | undefined {
  const normalized = planAccessDetail(detail);
  if (!/^SEARCH\b/.test(normalized)) return undefined;
  const seek = SEARCH_SEEK_RE.exec(normalized);
  if (seek) {
    return {
      target: seek[1]!,
      method: seek[2]!.trim(),
      constraint: seek[3]!,
      terms: constraintTerms(seek[3]!, detail),
    };
  }
  const virtual = SEARCH_VIRTUAL_TABLE_RE.exec(normalized);
  if (virtual) {
    return {
      target: virtual[1]!,
      method: virtual[2]!,
      constraint: undefined,
      terms: undefined,
    };
  }
  const end = SEARCH_END_SEEK_RE.exec(normalized);
  if (end) {
    return {
      target: end[1]!,
      method: end[2],
      constraint: undefined,
      terms: undefined,
    };
  }
  throw new Error(
    `d1-query-plan-gate cannot read the SEARCH row "${detail}"; its shape needs adding to parseSearchRow before the range rule or the key groups can classify it`,
  );
}

// The SCAN findings for one statement's EXPLAIN QUERY PLAN. A plan row is a
// finding when it SCANs a user table named in the statement (after
// FROM/JOIN/INTO/UPDATE), unless it rides a partial index that provably bounds
// the walked set (partialIndexBoundsWorkingSet).
//
// Only tables the statement NAMES count. SQLite's plan for an INSERT, UPDATE
// or DELETE on a parent table also lists a SCAN of every child table whose
// foreign-key column lacks a leading index - the deferred FK-integrity pass,
// not the statement's own work. Whether that probe has an index to ride is a
// schema question, not a plan one.
export function qScanFindings(
  qName: string,
  sql: string,
  plan: readonly PlanRow[],
  ctx: ScanRuleContext,
): QueryPlanFinding[] {
  const scanRe = /^SCAN\s+(\w+)(?:\s+USING\s+(?:COVERING\s+)?INDEX\s+(\w+))?/;
  const {
    userTableNames,
    partialIndexNames,
    modeledIndexRows,
    parentRowCounts,
  } = ctx;
  const { primaryTables, aliasToTable } = resolvePlanTables(
    sql,
    userTableNames,
  );
  const findings: QueryPlanFinding[] = [];
  for (const row of plan) {
    const m = scanRe.exec(planAccessDetail(row.detail));
    if (!m) continue;
    const target = m[1]!;
    const realTable = userTableNames.has(target)
      ? target
      : aliasToTable.get(target);
    if (!realTable) continue;
    if (!primaryTables.has(realTable)) continue;
    const usingIndex = m[2];
    const ridesPartial =
      usingIndex !== undefined && partialIndexNames.has(usingIndex);
    // A SCAN over a partial index walks only the partial's WHERE subset, so it
    // is exempt - but ONLY when that subset is provably bounded. An unbounded
    // partial is the same cost class as the full SCAN and stays a finding.
    if (
      ridesPartial &&
      partialIndexBoundsWorkingSet(
        usingIndex!,
        realTable,
        modeledIndexRows,
        parentRowCounts,
      )
    ) {
      continue;
    }
    if (ridesPartial) {
      // Distinct rule so a plain-SCAN exception for the same (table, query) -
      // which omits `index` and would wildcard-match - cannot silently absorb
      // an unbounded partial-index ride. Its justification (the lifecycle
      // invariant that bounds the in-flight set) is a different claim than a
      // SCAN exception, and `index` is tagged so an intentional ride is
      // excepted precisely by (table, query, index).
      findings.push({
        rule: "no-unbounded-partial-index",
        table: realTable,
        q: qName,
        index: usingIndex,
        detail: `${qName} plan: ${row.detail} - partial index walks ~${modeledIndexRows.get(usingIndex!) ?? "?"} rows, not an order of magnitude below the ${parentRowCounts.get(realTable) ?? "?"}-row ${realTable} (in-flight set is unbounded)`,
      });
    } else {
      findings.push({
        rule: "no-scan-on-user-tables",
        table: realTable,
        q: qName,
        detail: `${qName} plan: ${row.detail}`,
      });
    }
  }
  return findings;
}

// The range-SEARCH sibling of the SCAN rule. An index range SEARCH whose seek
// can walk to the retention-trimmed end of the table reads O(history), not
// O(working set): a finder with `sent_at < deadline` and no lower bound walks
// the table back to its retention horizon every run. EXPLAIN labels it SEARCH,
// so the SCAN rule waves it through; this rule reads the bracketed index
// constraint and flags the unbounded direction.
//
// Which end retention trims is what decides boundedness, so direction matters:
//   - upper-bound-only `(col<?)` / `(col<=?)`: the seek covers [min, ceil], and
//     min is the oldest surviving row - the retention floor, which recedes as
//     the table grows. UNBOUNDED (grows with retention).
//   - lower-bound-only `(col>?)` / `(col>=?)`: the seek covers [floor, max]. For
//     append-mostly time columns max ~ now, so a `col >= now - window` floor
//     reads only the recent window. BOUNDED.
//   - two-sided `(col>? AND col<?)`: each end pinned. BOUNDED - adding a lower
//     bound (a maximum age) is the usual fix for the unbounded case.
//   - an equality term `(col=? AND ...)` narrows the seek to one key group, but
//     does NOT prove that group is bounded. A low-cardinality equality column
//     (a mode or status flag) leaves its group near table size, so
//     `(flag=? AND ts<?)` still walks that group down to the retention floor.
//     Equality is therefore NOT an exemption: `(=? AND <?)` is a finding. An
//     equality prefix on a genuinely high-cardinality column (one user's rows)
//     IS bounded, but proving that needs the prefix-group cardinality, so it is
//     excepted with that count rather than blanket-exempted.
// So an upper range with no lower bound is unbounded - including when an
// equality prefix precedes it - UNLESS the index is a provably-bounded PARTIAL,
// whose WHERE caps the walked set regardless of the open upper range. That
// bound reuses the SCAN rule's partialIndexBoundsWorkingSet gate.
//
// Why this rule does NOT also flag lower-bound-only: a lower bound reads the
// recent window, not the retention floor, so flagging it would false-positive
// every `col >= now - window` finder. The residual case a static reader cannot
// catch - a lower bound against a FIXED constant rather than a moving
// `now - window` - needs a measured rows-read budget instead.
//
// Second blind spot, same backstop - a SELECTIVE RESIDUAL FILTER on a column
// absent from the chosen index. A lower bound this rule reads as bounded only
// bounds the RANGE column; if the statement's real selectivity is a residual
// equality or `IN` on a non-indexed column, the plan's constraint paren shows
// only the seek keys - residual filters are not emitted - so this rule sees a
// bounded recent-window seek while the seek walks every row in that window and
// discards the non-matching ones. The structural fix is to lead the index with
// the residual column so it becomes a seek key; detection needs a rows-read
// measurement, which no EXPLAIN-based reader provides.
//
// Scope: reads only. A DELETE/UPDATE retention sweep runs a `ts < cutoff` range
// on purpose - seeking the OLD end via the index is the ideal retention shape,
// it deletes the rows it matches (so the set shrinks, not accumulates) and
// bounds the batch with LIMIT. That is the opposite of the finder harm
// (re-scanning an ever-growing set to find ~0 actionable rows), so mutations
// are skipped.
export function qRangeSearchFindings(
  qName: string,
  sql: string,
  plan: readonly PlanRow[],
  ctx: ScanRuleContext,
): QueryPlanFinding[] {
  if (/^\s*(?:DELETE|UPDATE)\b/i.test(sql)) return [];
  // Any SEARCH with a range constraint is classified regardless of the access
  // method, so a primary-key range plan - `SEARCH t USING INTEGER PRIMARY KEY
  // (rowid<?)`, or `SEARCH t USING PRIMARY KEY (id<?)` on a WITHOUT ROWID
  // table - is read too. A rowid/PK range is the same upper-bound-only
  // retention-floor walk as an index range (rowid correlates with insertion
  // order), and keying only on `USING INDEX` would fail OPEN on it before the
  // constraint is ever parsed.
  //
  // The index name, if the access path is an index - the bounded-partial
  // exemption below must key on a real partial index. A PK or other access
  // path has no index name (never a partial), so the method text labels it.
  const indexRe = /^(?:COVERING\s+)?INDEX\s+(\w+)$/;
  const {
    userTableNames,
    partialIndexNames,
    modeledIndexRows,
    parentRowCounts,
  } = ctx;
  const { aliasToTable } = resolvePlanTables(sql, userTableNames);
  const findings: QueryPlanFinding[] = [];
  for (const row of plan) {
    const search = parseSearchRow(row.detail);
    if (search?.terms === undefined) continue;
    const { target, terms } = search;
    const method = search.method!;
    const realTable = userTableNames.has(target)
      ? target
      : aliasToTable.get(target);
    if (!realTable) continue;
    const idxMatch = indexRe.exec(method);
    const usingIndex = idxMatch ? idxMatch[1]! : method;
    let hasLower = false;
    let hasUpper = false;
    for (const { op } of terms) {
      if (op === ">" || op === ">=") hasLower = true;
      else if (op === "<" || op === "<=") hasUpper = true;
      // `=` terms are intentionally ignored: an equality narrows the seek to
      // one key group but does NOT bound that group's size. Equality therefore
      // neither exempts nor flags here. A skip-scan `ANY` term bounds even
      // less, for the same reason.
    }
    // Bounded: a lower bound (two-sided OR lower-only) starts the seek above the
    // retention floor and reads only the recent window, regardless of how large
    // the surrounding key group is. SQLite lists the equality prefix plus at
    // most one range column in the constraint paren (residual filters are not
    // shown), so a lower bound here always belongs to the range column.
    if (hasLower) continue;
    // No upper range at all (equality-only, or an IS NULL term the index
    // serves) - not this shape.
    if (!hasUpper) continue;
    // Upper-bound-only: unbounded unless a provably-bounded partial caps the walk.
    if (
      partialIndexNames.has(usingIndex) &&
      partialIndexBoundsWorkingSet(
        usingIndex,
        realTable,
        modeledIndexRows,
        parentRowCounts,
      )
    ) {
      continue;
    }
    findings.push({
      rule: "no-unbounded-range-search",
      table: realTable,
      q: qName,
      index: usingIndex,
      detail: `${qName} plan: ${row.detail} - upper-bound-only range SEARCH on ${usingIndex} walks ${realTable} down to the retention floor (no lower bound, index is not a bounded partial; an equality prefix here would not bound the walk unless the prefix group is provably small). Add a lower bound on the indexed column (a maximum age) so the seek covers only the active window, or except it with the prefix-group cardinality.`,
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Key groups.
//
// The SCAN and range rules read the plan's constraint paren to decide whether
// a seek is bounded, and each is structurally blind to one shape: a seek whose
// equality prefix pins a key GROUP rather than a key. The group's size is not
// in the plan, so a read returning one row while walking a whole accumulating
// group looks identical to one that walks almost nothing. What separates them
// is which predicates became seek keys - and that is exactly what the paren
// says.
//
// So this does not try to price the group. It extracts the group's identity
// (table, index, constraint paren) for the caller to hold against a reviewed
// roster, where a human answers "why is this group bounded?" once per group.
// ---------------------------------------------------------------------------

export interface KeyGroup {
  table: string;
  index: string;
  constraint: string;
  // The index's partial predicate, or undefined for a full index. Part of the
  // key: a seek's bound can rest entirely on the predicate, and dropping one
  // changes neither the index name nor the constraint paren, so an entry keyed
  // without it would keep excusing a walk the predicate no longer bounds.
  partialPredicate?: string;
}

export interface KeyGroupContext {
  userTableNames: ReadonlySet<string>;
  uniqueIndexNames: ReadonlySet<string>;
  // Partial-index predicates by index name, normalized to single spaces. Absent
  // for a full index.
  partialIndexPredicates: ReadonlyMap<string, string>;
  // Named columns per index. An index carrying an EXPRESSION column is absent
  // here: pragma_index_info reports a NULL name for one, so its column set
  // cannot be matched against the constraint's terms and the pinned test below
  // must fail closed rather than guess.
  indexNamedColumnCounts: ReadonlyMap<string, number>;
}

// The key a roster entry is written against. Contains the constraint paren
// because that is the whole point: re-key the index under a read and the paren
// changes, so the entry that justified the old walk stops matching and the gate
// fails instead of inheriting an excuse nobody re-examined.
export function keyGroupId(group: KeyGroup): string {
  const index =
    group.partialPredicate === undefined
      ? group.index
      : `${group.index} WHERE ${group.partialPredicate}`;
  return `${group.table} | ${index} | (${group.constraint})`;
}

// A statement whose result set is structurally bounded regardless of how much
// data it walks: a LIMIT with a literal count, or a bare aggregate with no
// GROUP BY (one row out, whatever came in). That gap - bounded result over an
// unbounded walk - is the cost no EXPLAIN-based reader can price, so it is
// what selects the population.
//
// A LIMIT bound by a parameter is deliberately not this shape: the count comes
// from the caller, so the result is not structurally bounded.
//
// ON A MUTATION, A TOP-LEVEL LIMIT IS A BATCH SIZE, NOT A BOUNDED RESULT. A
// retention sweep ranges over the old end of a table on purpose, deletes what
// it matches so the set shrinks, and caps the batch with LIMIT - the opposite
// of the harm here, and the reason the range rule skips mutations too. But
// that is the LIMIT's doing, not the statement's: a DELETE or UPDATE whose own
// predicate reads a bare aggregate over an accumulating group (a `COUNT(*)`
// cap check, a recomputed `MAX(ts)`) is exactly this shape, and excluding
// every mutation to be rid of the sweeps takes those with it. Scoping the
// exclusion to the LIMIT keeps the sweeps out and lets the rest in.
export function hasStructurallyBoundedResult(sql: string): boolean {
  const isMutation = /^\s*(?:DELETE|UPDATE)\b/i.test(sql);
  if (!isMutation && /\bLIMIT\s+\d+\b/i.test(sql)) return true;
  return (
    /\b(?:COUNT|MAX|MIN|SUM|TOTAL|AVG)\s*\(/i.test(sql) &&
    !/\bGROUP\s+BY\b/i.test(sql)
  );
}

// The key groups one statement's plan seeks, minus every seek already pinned
// to at most one row. Returns [] for a statement out of scope.
//
// Scope: any statement whose result is structurally bounded, mutations
// included - hasStructurallyBoundedResult is what keeps the retention sweeps
// out, by discounting their batch LIMIT rather than by their statement kind.
// An INSERT's ceiling subqueries and INSERT ... SELECT drivers are reads, and
// so are an UPDATE's.
//
// Second scope rule, borrowed from the SCAN rule for the same reason: only
// tables the statement's SQL NAMES count, so the deferred FK-integrity probes
// SQLite lists for a parent-table write are not enrolled.
export function qKeyGroups(
  sql: string,
  plan: readonly PlanRow[],
  ctx: KeyGroupContext,
): KeyGroup[] {
  if (!hasStructurallyBoundedResult(sql)) return [];
  // Only index access paths carry a key group. A rowid equality reaches one row
  // by definition, and a rowid RANGE is the range rule's upper-bound case -
  // neither is a group whose size someone has to reason about. A bare `PRIMARY
  // KEY` seek is NOT that: it is a WITHOUT ROWID table's key, which may be
  // composite, and a prefix of a composite key matches a group. Every method
  // other than an index or the rowid throws rather than being skipped: a
  // skipped row enrolls nothing, so an AUTOMATIC index, a WITHOUT ROWID key, or
  // a method SQLite adds later would leave the roster without a seeker it never
  // saw.
  const indexRe = /^(?:COVERING\s+)?INDEX\s+(\w+)$/;
  const rowidRe = /^INTEGER\s+PRIMARY\s+KEY$/;
  const { userTableNames, uniqueIndexNames, indexNamedColumnCounts } = ctx;
  const { primaryTables, aliasToTable } = resolvePlanTables(
    sql,
    userTableNames,
  );
  const groups: KeyGroup[] = [];
  for (const row of plan) {
    const search = parseSearchRow(row.detail);
    if (search?.constraint === undefined) continue;
    const indexMatch = indexRe.exec(search.method!);
    if (!indexMatch) {
      if (rowidRe.test(search.method!)) continue;
      throw new Error(
        `d1-query-plan-gate has no key-group reading for the access method "${search.method}" in "${row.detail}"; it needs classifying in qKeyGroups before a roster can see its seekers`,
      );
    }
    const { target, constraint } = search;
    const index = indexMatch[1]!;
    const realTable = userTableNames.has(target)
      ? target
      : aliasToTable.get(target);
    if (realTable === undefined) continue;
    if (!primaryTables.has(realTable)) continue;
    // Pinned to at most one row: the index is UNIQUE and every one of its
    // columns carries an equality term, so the constraint names a key rather
    // than a prefix of one. A UNIQUE index only partly matched (`(a_id=?)` on
    // UNIQUE(a_id, b_id)) pins a group, not a key, so it stays. `<expr>` is
    // left out: an expression column has no name to count against, which is
    // why the index's named-column count is absent below.
    const equalityTerms = search.terms!.filter(
      (term) => term.op === "=" && term.column !== "<expr>",
    ).length;
    const namedColumns = indexNamedColumnCounts.get(index);
    if (
      uniqueIndexNames.has(index) &&
      namedColumns !== undefined &&
      equalityTerms >= namedColumns
    ) {
      continue;
    }
    const partialPredicate = ctx.partialIndexPredicates.get(index);
    groups.push({
      table: realTable,
      index,
      constraint,
      ...(partialPredicate === undefined ? {} : { partialPredicate }),
    });
  }
  return groups;
}
