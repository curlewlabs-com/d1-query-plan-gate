// The filters a SQLite index walk tests after its seek key, recovered from
// the main EXPLAIN program. A failed predicate can advance the loop without
// producing a row, including inside a MULTI-INDEX OR arm's shared subroutine.
//
// WHAT IT TRUSTS. These facts about SQLite's code generator, each checked where
// it is used rather than assumed: a seek's loop is the stretch from the address
// its Next jumps back to up to that Next, and the bytecode emits a statement's
// index seeks in the order EXPLAIN QUERY PLAN lists them, since the program and
// its plan rows come from one pass that codes each loop as it plans it. The
// order is checked per index: the plan and the program must name the same
// number of seeks, each paired seek's key width must fit its plan row's terms,
// or this throws rather than pair a seek with another seek's residual. And
// control passes between instructions as each opcode's jumps say (successors
// in sqlite-opcodes.ts), which is what lets a test's operand be read from every
// write that can reach it rather than from the nearest one above it.

import type { PlanRow } from "./database";
import { loopRejections } from "./loop-rejections";
import { parseSearchRow } from "./plan-lint";
import {
  COMPARE_OPCODES,
  LOOP_STEP_OPCODES,
  MIRRORED,
  OPEN_OPCODES,
  OTHER_JUMPS,
  POSITIONING,
  REJECTING_JUMPS,
  SINGLE_OPERAND_TESTS,
  STRUCTURAL_JUMPS,
  WALK_START_OPCODES,
  columnWrite,
  effectOn,
  literalValue,
  successors,
  type BytecodeRow,
} from "./sqlite-opcodes";

// The schema facts the bytecode names by number: which b-tree a root page is,
// and each b-tree's columns in the order a Column opcode counts them.
export interface BytecodeContext {
  objectsByRootPage: ReadonlyMap<
    number,
    { name: string; type: "table" | "index"; table: string }
  >;
  columnsByObject: ReadonlyMap<string, readonly (string | null)[]>;
}

// One index seek: the index, and every test its loop rejects an entry with
// after the key, sorted. A comparison reads `<subject>(<opcode> <compared>)`,
// a single-operand test `<subject>(<opcode>)`. The subject is a column of the
// sought row by name, or `<expr>` for anything else: an outer row's column, a
// subquery's answer, a joined row's absence, a value an unmodeled opcode wrote.
// The compared value is read the same way, and also as `?` for a bound
// parameter, a literal by its value, or `<table>.<column>` for a column of a
// row outside the loop. Subject and compared value read as `<expr>` unless
// every definition of the register that can reach the test says the same
// thing.
//
// KNOWN LIMIT. Arithmetic on the compared side reads as `<expr>` whatever its
// terms, so `created_at > ? - 86400` and `created_at > ? - 172800` key alike.
// Keying on each statement's SQL would catch it and re-enroll every entry on
// any edit to a seeking query, a change detector.
export interface IndexSeek {
  index: string;
  // How many key fields the walk starts from: a Seek's key width, 0 for a
  // Rewind or Last. residualByPlanRow checks it against the plan row it pairs.
  startKeyFields: number;
  residual: readonly string[];
}

// What a filter's operand holds: a column of the sought row, a bound
// parameter, a literal, a column of a row outside the loop, or <expr>.
interface Operand {
  kind: "row" | "bind" | "literal" | "outer" | "expr";
  text: string;
}
const EXPR: Operand = { kind: "expr", text: "<expr>" };

function agreedValue(values: ReadonlyMap<string, Operand>): Operand {
  return values.size === 1 ? (values.values().next().value ?? EXPR) : EXPR;
}

// A filter's subject names a column only of the sought row: a test on any
// other value reads as <expr>, so the key says which of the row's columns it
// rejects entries by, and nothing else.
function subject(operand: Operand): string {
  return operand.kind === "row" ? operand.text : "<expr>";
}

// EXPLAIN lists a statement's main program and then each trigger or
// foreign-key action program it runs, every one numbered from address 0.
// EXPLAIN QUERY PLAN describes the main program alone, so only it is read: an
// action program's walks are the schema's, not the statement's.
export function indexSeeks(
  rows: readonly BytecodeRow[],
  ctx: BytecodeContext,
): IndexSeek[] {
  const restart = rows.findIndex((row, i) => i > 0 && row.addr === 0);
  return programSeeks(restart === -1 ? rows : rows.slice(0, restart), ctx);
}

function programSeeks(
  program: readonly BytecodeRow[],
  ctx: BytecodeContext,
): IndexSeek[] {
  const byAddr = new Map(program.map((row) => [row.addr, row]));
  // A program reuses cursor numbers - a DELETE's foreign-key probes reopen one
  // its own seek already used - so a cursor names the b-tree its latest open
  // before the instruction reading it put there.
  const objectAt = (
    cursor: number,
    addr: number,
  ): { name: string; type: "table" | "index"; table: string } | undefined => {
    for (let at = addr - 1; at >= 0; at -= 1) {
      const row = byAddr.get(at);
      if (row === undefined || !OPEN_OPCODES.has(row.opcode)) continue;
      if (row.p1 !== cursor) continue;
      return ctx.objectsByRootPage.get(row.p2);
    }
    return undefined;
  };
  const predecessors = new Map<number, BytecodeRow[]>();
  for (const row of program) {
    for (const next of successors(row)) {
      const list = predecessors.get(next) ?? [];
      list.push(row);
      predecessors.set(next, list);
    }
  }
  // The init section runs once, before the first instruction after Init, so
  // nothing it writes changes while any loop runs.
  const initStart = program[0]?.opcode === "Init" ? program[0].p2 : Infinity;
  const writesIn = (
    from: number,
    to: number,
    register: number,
    skip: (addr: number) => boolean = () => false,
  ): boolean =>
    program.some(
      (row) =>
        row.addr >= from &&
        row.addr <= to &&
        !skip(row.addr) &&
        effectOn(row, register) !== "none",
    );
  // The code of the coroutine a Yield resumes or returns from: from the
  // address its InitCoroutine starts it at up to the one that InitCoroutine
  // jumps past it to.
  const coroutineOf = (
    yieldRow: BytecodeRow,
  ): { from: number; to: number } | undefined => {
    const init = program.find(
      (r) => r.opcode === "InitCoroutine" && r.p1 === yieldRow.p1 && r.p2 !== 0,
    );
    return init === undefined ? undefined : { from: init.p3, to: init.p2 - 1 };
  };
  // Whether the code a Gosub or Yield runs before control comes back may write
  // `register`: a subroutine runs from the Gosub's target to its Return, and a
  // Yield runs the other side of its coroutine, the coroutine's own code from
  // outside it, or from inside it any of the program but that code and the
  // init section. A coroutine's own writes are read where it yields
  // (definitionValue); a write on the far side of a Yield out of one is not.
  const callEffect = (
    row: BytecodeRow,
    register: number,
  ): "writes" | "none" | "unknown" => {
    if (row.opcode === "Gosub") {
      const ret = program.find(
        (r) => r.addr >= row.p2 && r.opcode === "Return" && r.p1 === row.p1,
      );
      if (ret === undefined) return "unknown";
      return writesIn(row.p2, ret.addr, register) ? "unknown" : "none";
    }
    if (row.opcode === "Yield") {
      const body = coroutineOf(row);
      if (body === undefined) return "unknown";
      const inCoroutine = (addr: number): boolean =>
        addr >= body.from && addr <= body.to;
      if (inCoroutine(row.addr)) {
        return writesIn(0, initStart - 1, register, inCoroutine)
          ? "unknown"
          : "none";
      }
      return writesIn(body.from, body.to, register) ? "writes" : "none";
    }
    return effectOn(row, register);
  };

  const seeks: IndexSeek[] = [];
  const stepsSeen = new Set<number>();
  for (const start of program) {
    if (!WALK_START_OPCODES.has(start.opcode)) continue;
    const object = objectAt(start.p1, start.addr);
    if (object?.type !== "index") continue;
    const cursor = start.p1;
    const startKeyFields =
      start.opcode === "Rewind" || start.opcode === "Last"
        ? 0
        : Number(start.p4 ?? 0);
    // The loop's Next is the first step on this cursor after the start whose
    // jump-back lands between the two. A start with none reads one entry - the
    // min/max optimization's single probe - and has nothing to step past.
    const step = program.find(
      (row) =>
        row.addr > start.addr &&
        LOOP_STEP_OPCODES.has(row.opcode) &&
        row.p1 === cursor &&
        row.p2 > start.addr &&
        row.p2 <= row.addr,
    );
    if (step === undefined) {
      seeks.push({ index: object.name, startKeyFields, residual: [] });
      continue;
    }
    // A skip-scan starts one loop twice - a Rewind for the first key prefix,
    // then a Seek past each prefix it has done with - and the plan lists it
    // once, so the loop is the walk and its first start stands for it.
    if (stepsSeen.has(step.addr)) continue;
    stepsSeen.add(step.addr);
    const { body, jumps, calls } = loopRejections(program, step, predecessors);
    // The cursors the loop reads the sought row through: the index's own, and
    // the table cursor a DeferredSeek moves to the entry's rowid.
    const rowCursors = new Set([cursor]);
    // Cursors something in the body moves: a nested loop's or a lookup's,
    // whose columns change per entry of this loop.
    const movedInBody = new Set<number>();
    for (const row of body) {
      if (row.opcode === "DeferredSeek" && row.p1 === cursor) {
        rowCursors.add(row.p3);
      }
      if (POSITIONING.has(row.opcode)) movedInBody.add(row.p1);
      if (row.opcode === "DeferredSeek") movedInBody.add(row.p3);
    }
    // What one definition of a register says it holds.
    const definitionValue = (row: BytecodeRow, register: number): Operand => {
      const write = columnWrite(row);
      if (write !== undefined) {
        const read =
          write.cursor === cursor && body.has(row)
            ? object
            : objectAt(write.cursor, row.addr);
        const name =
          write.column === "rowid"
            ? "rowid"
            : read === undefined
              ? undefined
              : ctx.columnsByObject.get(read.name)?.[write.column];
        if (read === undefined || name == null) return EXPR;
        if (rowCursors.has(write.cursor)) {
          return body.has(row) ? { kind: "row", text: name } : EXPR;
        }
        if (movedInBody.has(write.cursor)) return EXPR;
        return { kind: "outer", text: `${read.table}.${name}` };
      }
      // A copy holds whatever its source held where the copy ran, often a
      // cached subquery's answer copied out of the block that computed it.
      if (
        row.opcode === "Copy" ||
        row.opcode === "SCopy" ||
        row.opcode === "Move"
      ) {
        return operandValue(row.p1 + (register - row.p2), row.addr);
      }
      // A Yield into a coroutine that writes the register leaves it holding
      // what the coroutine wrote by the time it yielded back, or ended.
      if (row.opcode === "Yield") {
        const coroutine = coroutineOf(row);
        const exits = program.filter(
          (r) =>
            coroutine !== undefined &&
            r.addr >= coroutine.from &&
            r.addr <= coroutine.to &&
            (r.opcode === "Yield" || r.opcode === "EndCoroutine") &&
            r.p1 === row.p1,
        );
        const values = new Map<string, Operand>();
        for (const exit of exits) {
          const value = operandValue(register, exit.addr);
          values.set(`${value.kind} ${value.text}`, value);
        }
        return agreedValue(values);
      }
      if (row.opcode === "Variable") return { kind: "bind", text: "?" };
      const literal = literalValue(row);
      return literal === undefined ? EXPR : { kind: "literal", text: literal };
    };
    // What a register holds when control reaches `at`: the one value every
    // definition that can reach it agrees on, or <expr>. It walks back along
    // every path and stops each at its nearest write, so a CASE's arms, which
    // write one register on different paths, all count, and a register reused
    // for another value elsewhere in the loop does not.
    const memo = new Map<string, Operand>();
    const operandValue = (register: number, at: number): Operand => {
      const key = `${register}@${at}`;
      const known = memo.get(key);
      if (known !== undefined) return known;
      // A copy chain that comes back to itself has no value of its own.
      memo.set(key, EXPR);
      const values = new Map<string, Operand>();
      const visited = new Set<number>();
      const pending = [at];
      for (
        let addr = pending.pop();
        addr !== undefined && values.size < 2;
        addr = pending.pop()
      ) {
        if (visited.has(addr)) continue;
        visited.add(addr);
        // The entry edge sees the caller's incoming registers. callEffect
        // summarizes what the callee wrote only on the edge back to the caller.
        for (const call of calls.get(addr) ?? []) {
          if (call.p1 === register)
            values.set(`${EXPR.kind} ${EXPR.text}`, EXPR);
          else pending.push(call.addr);
        }
        for (const row of predecessors.get(addr) ?? []) {
          const effect = callEffect(row, register);
          if (effect === "none") {
            pending.push(row.addr);
          } else {
            const value =
              effect === "unknown" ? EXPR : definitionValue(row, register);
            values.set(`${value.kind} ${value.text}`, value);
          }
        }
      }
      const value = agreedValue(values);
      memo.set(key, value);
      return value;
    };
    const residual = new Set<string>();
    for (const jump of jumps) {
      if (STRUCTURAL_JUMPS.has(jump.opcode)) {
        continue;
      }
      if (OTHER_JUMPS.has(jump.opcode)) {
        throw new Error(
          `residual-walks.ts has not classified ${jump.opcode} at ${jump.addr}, whose branch leads to the Next of the loop on ${object.name}; add it to REJECTING_JUMPS or STRUCTURAL_JUMPS`,
        );
      }
      if (!REJECTING_JUMPS.has(jump.opcode)) continue;
      // Every rejection is a filter, whatever it reads: a test on a value
      // fixed for the loop that comes out false rejects every entry, and the
      // loop walks its whole range to return nothing. The rejecting opcode is
      // part of the filter: `id != ?` rejects at most the one entry equal to
      // it, `id < ?` every entry past it.
      if (COMPARE_OPCODES.has(jump.opcode)) {
        // SQLite jumps when r[p3] <opcode> r[p1].
        const left = operandValue(jump.p3, jump.addr);
        const right = operandValue(jump.p1, jump.addr);
        residual.add(
          right.kind === "row" && left.kind !== "row"
            ? `${right.text}(${MIRRORED[jump.opcode]} ${left.text})`
            : `${subject(left)}(${jump.opcode} ${right.text})`,
        );
      } else if (SINGLE_OPERAND_TESTS.has(jump.opcode)) {
        residual.add(
          `${subject(operandValue(jump.p1, jump.addr))}(${jump.opcode})`,
        );
      } else {
        residual.add(`<expr>(${jump.opcode})`);
      }
    }
    seeks.push({
      index: object.name,
      startKeyFields,
      residual: [...residual].sort(),
    });
  }
  return seeks;
}

// The index a plan row walks, SEARCH or SCAN, and how many of its terms are
// equalities, or undefined for a row that walks no index. A SCAN counts as a
// SEARCH does: the bytecode starts a walk for each.
function planRowWalk(
  detail: string,
): { index: string; equalities: number; terms: number } | undefined {
  const search = parseSearchRow(detail);
  if (search !== undefined) {
    const index = /^(?:COVERING\s+)?INDEX\s+(\w+)$/.exec(
      search.method ?? "",
    )?.[1];
    if (index === undefined) return undefined;
    // A SEARCH with no paren is the min/max optimization's probe of an
    // index end: no key at all.
    const terms = search.terms ?? [];
    return {
      index,
      equalities: terms.filter((t) => t.op === "=").length,
      terms: terms.length,
    };
  }
  const scan = /^SCAN \S+(?: EXISTS)? USING (?:COVERING )?INDEX (\w+)/.exec(
    detail.trim(),
  )?.[1];
  return scan === undefined
    ? undefined
    : { index: scan, equalities: 0, terms: 0 };
}

// Each index walk in a statement's plan paired with its residual, in plan
// order. Throws when the plan and the bytecode disagree on how many walks an
// index takes, or a paired walk starts from a key wider or narrower than its
// plan row's terms allow - the equalities, plus at most the range bound the
// walk starts from, or SQLite's NULL-skipping lower bound - since pairing by
// order is then pairing by guess.
export function residualByPlanRow(
  qName: string,
  plan: readonly PlanRow[],
  seeks: readonly IndexSeek[],
): Map<PlanRow, readonly string[]> {
  const planRowsByIndex = new Map<
    string,
    { row: PlanRow; equalities: number; terms: number }[]
  >();
  for (const row of plan) {
    const walk = planRowWalk(row.detail);
    if (walk === undefined) continue;
    const rows = planRowsByIndex.get(walk.index) ?? [];
    rows.push({ row, equalities: walk.equalities, terms: walk.terms });
    planRowsByIndex.set(walk.index, rows);
  }
  const seeksByIndex = new Map<string, IndexSeek[]>();
  for (const seek of seeks) {
    const list = seeksByIndex.get(seek.index) ?? [];
    list.push(seek);
    seeksByIndex.set(seek.index, list);
  }
  const indexes = new Set([...planRowsByIndex.keys(), ...seeksByIndex.keys()]);
  const paired = new Map<PlanRow, readonly string[]>();
  for (const index of indexes) {
    const rows = planRowsByIndex.get(index) ?? [];
    const walks = seeksByIndex.get(index) ?? [];
    if (walks.length !== rows.length) {
      throw new Error(
        `${qName}: EXPLAIN QUERY PLAN lists ${rows.length} walk(s) on ${index} and the bytecode starts ${walks.length}; residual-walks.ts cannot pair them`,
      );
    }
    rows.forEach(({ row, equalities, terms }, i) => {
      const walk = walks[i];
      if (
        walk === undefined ||
        walk.startKeyFields < equalities ||
        walk.startKeyFields > Math.min(terms, equalities + 1) + 1
      ) {
        throw new Error(
          `${qName}: the plan row "${row.detail}" has ${equalities} equality term(s) of ${terms}, and the walk paired with it starts from ${walk?.startKeyFields} key field(s); residual-walks.ts has paired the wrong walks`,
        );
      }
      paired.set(row, walk.residual);
    });
  }
  return paired;
}
