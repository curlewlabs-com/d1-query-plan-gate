// Register effects and control-flow edges of the SQLite opcodes the detector
// recognizes. Unknown register writes degrade an operand to <expr>. A new
// branching opcode can change a loop's shape and needs checking on upgrades.

export interface BytecodeRow {
  addr: number;
  opcode: string;
  p1: number;
  p2: number;
  p3: number;
  p4: string | null;
}

// Opcodes that start a walk on an index cursor. Rewind and Last start one with
// no lower key: a SCAN, or a SEARCH ranged only from above.
export const WALK_START_OPCODES = new Set([
  "SeekGE",
  "SeekGT",
  "SeekLE",
  "SeekLT",
  "Rewind",
  "Last",
]);
export const OPEN_OPCODES = new Set(["OpenRead", "OpenWrite", "ReopenIdx"]);
export const LOOP_STEP_OPCODES = new Set(["Next", "Prev"]);

// Opcodes whose p2 is a branch target taken on a condition, and the operand
// registers each reads. A comparison reads p1 and p3; the single-operand
// tests read p1. Rejections from lookups have no named comparison operand.
export const COMPARE_OPCODES = new Set(["Eq", "Ne", "Lt", "Le", "Gt", "Ge"]);
export const SINGLE_OPERAND_TESTS = new Set([
  "If",
  "IfNot",
  "IsNull",
  "NotNull",
  "IsType",
]);

// The branch opcodes that can reject an entry on the way to its loop's Next:
// the comparisons and single-operand tests, whose operands are traced, and
// the lookups that branch on a row's absence (an IN or NOT IN probe, a rowid
// lookup, a Bloom filter), whose rejection is recorded as <expr>.
export const REJECTING_JUMPS = new Set([
  ...COMPARE_OPCODES,
  ...SINGLE_OPERAND_TESTS,
  "Found",
  "NotFound",
  "NotExists",
  "SeekRowid",
  "IfNullRow",
  "Filter",
]);

// Jumps that land on a loop's Next without rejecting an entry the key
// admitted. RowSetTest is MULTI-INDEX OR's de-duplication: an arm skips an entry
// an earlier arm already produced, which that arm's own walk paid for. IfPos is
// a LEFT JOIN's matched-row flag, and Goto the unconditional continue after an
// entry is produced. The seeks, range ends and steps belong to a loop nested in
// this one, whose exhaustion continues this loop - so a join whose inner side
// finds no row for an outer entry is not reported here: this reads filters on
// the sought row, not join selectivity.
export const STRUCTURAL_JUMPS = new Set([
  "RowSetTest",
  "IfPos",
  "Goto",
  "SeekGE",
  "SeekGT",
  "SeekLE",
  "SeekLT",
  "Rewind",
  "Last",
  "IdxGE",
  "IdxGT",
  "IdxLE",
  "IdxLT",
  "Next",
  "Prev",
]);

// Every other SQLite opcode whose p2 is a branch target. One of these landing
// on a loop's Next is a branch this file has not classified, so it throws
// rather than read as no filter: the direction a misread must not fail is
// toward a walk going unreported. For any opcode outside these sets p2 is
// an ordinary operand - a column number or a register - and a match on the
// Next's address is coincidence.
export const OTHER_JUMPS = new Set([
  "Init",
  "Gosub",
  "InitCoroutine",
  "Yield",
  "EndCoroutine",
  "HaltIfNull",
  "Jump",
  "Once",
  "ElseEq",
  "MustBeInt",
  "IfNotOpen",
  "IfNoHope",
  "NoConflict",
  "SeekScan",
  "IfSizeBetween",
  "SorterSort",
  "Sort",
  "IfEmpty",
  "SorterNext",
  "RowSetRead",
  "Program",
  "FkIfZero",
  "IfNotZero",
  "DecrJumpZero",
  "VFilter",
  "VNext",
]);

// The registers each modeled opcode writes. An opcode missing here that names
// a register in p1, p2 or p3 is treated as possibly writing it, which reads as
// <expr>: a test on a value this file cannot trace is reported as a filter,
// never assumed constant.
const REGISTER_WRITES: Readonly<
  Record<string, (row: BytecodeRow) => readonly number[]>
> = {
  Column: (r) => [r.p3],
  Rowid: (r) => [r.p2],
  IdxRowid: (r) => [r.p2],
  Cast: (r) => [r.p1],
  Integer: (r) => [r.p2],
  Int64: (r) => [r.p2],
  Real: (r) => [r.p2],
  String8: (r) => [r.p2],
  String: (r) => [r.p2],
  Blob: (r) => [r.p2],
  Variable: (r) => [r.p2],
  Null: (r) => range(r.p2, Math.max(r.p2, r.p3)),
  Copy: (r) => range(r.p2, r.p2 + r.p3),
  SCopy: (r) => [r.p2],
  Move: (r) => range(r.p2, r.p2 + r.p3 - 1),
  Function: (r) => [r.p3],
  PureFunc: (r) => [r.p3],
  Add: (r) => [r.p3],
  Subtract: (r) => [r.p3],
  Multiply: (r) => [r.p3],
  Divide: (r) => [r.p3],
  Remainder: (r) => [r.p3],
  Concat: (r) => [r.p3],
  BitAnd: (r) => [r.p3],
  BitOr: (r) => [r.p3],
  ShiftLeft: (r) => [r.p3],
  ShiftRight: (r) => [r.p3],
  Not: (r) => [r.p2],
  BitNot: (r) => [r.p2],
  IsTrue: (r) => [r.p2],
  ZeroOrNull: (r) => [r.p2],
  AggFinal: (r) => [r.p1],
  AggValue: (r) => [r.p3],
  AggStep: (r) => [r.p3],
  MakeRecord: (r) => [r.p3],
  Count: (r) => [r.p2],
  Sequence: (r) => [r.p2],
  BeginSubrtn: (r) => [r.p2],
  IfNullRow: (r) => [r.p3],
  SorterData: (r) => [r.p2],
  IntCopy: (r) => [r.p2],
  Param: (r) => [r.p2],
  NewRowid: (r) => [r.p2],
  VColumn: (r) => [r.p3],
  RowSetRead: (r) => [r.p3],
  SoftNull: (r) => [r.p1],
  MemMax: (r) => [r.p1],
  AddImm: (r) => [r.p1],
  InitCoroutine: (r) => [r.p1],
  DecrJumpZero: (r) => [r.p1],
  IfNotZero: (r) => [r.p1],
};

// Opcodes that change a register's type in place, read registers without
// writing one a test reads, or name only cursors and counts: none gives a
// register a new value.
const REGISTER_NEUTRAL = new Set([
  "Affinity",
  "RealAffinity",
  "MustBeInt",
  ...COMPARE_OPCODES,
  ...SINGLE_OPERAND_TESTS,
  ...STRUCTURAL_JUMPS,
  "Found",
  "NotFound",
  "NotExists",
  "SeekRowid",
  "Filter",
  "DeferredSeek",
  "ResultRow",
  "IdxInsert",
  "Insert",
  "IdxDelete",
  "Delete",
  "RowSetAdd",
  "Return",
  "Once",
  "Halt",
  "OpenRead",
  "OpenWrite",
  "ReopenIdx",
  "OpenEphemeral",
  "OpenDup",
  "Close",
  "NullRow",
  "SeekHit",
  "Noop",
  "Explain",
  "CollSeq",
  "Compare",
  "FilterAdd",
  "HaltIfNull",
  "TypeCheck",
  "NoConflict",
  "FinishSeek",
  "IfEmpty",
  "IfNoHope",
  "SeekScan",
  "SorterOpen",
  "SorterInsert",
  "SorterSort",
  "Sort",
  "SorterNext",
  "OpenPseudo",
  "Transaction",
  "VOpen",
  "VFilter",
  "VNext",
  "ResetCount",
  "FkCounter",
  "FkCheck",
  "FkIfZero",
  "Init",
  "Jump",
]);

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let r = from; r <= to; r += 1) out.push(r);
  return out;
}

// Whether an instruction writes `register`: yes, no, or possibly, for an
// opcode this file does not model that names it.
export function effectOn(
  row: BytecodeRow,
  register: number,
): "writes" | "none" | "unknown" {
  const writes = REGISTER_WRITES[row.opcode];
  if (writes !== undefined) {
    return writes(row).includes(register) ? "writes" : "none";
  }
  if (REGISTER_NEUTRAL.has(row.opcode)) return "none";
  return [row.p1, row.p2, row.p3].includes(register) ? "unknown" : "none";
}

// Opcodes that write a column of the cursor in p1 into register p3 (Column)
// or p2 (the rowid reads).
export function columnWrite(
  row: BytecodeRow,
): { cursor: number; column: number | "rowid"; register: number } | undefined {
  if (row.opcode === "Column") {
    return { cursor: row.p1, column: row.p2, register: row.p3 };
  }
  if (row.opcode === "IdxRowid" || row.opcode === "Rowid") {
    return { cursor: row.p1, column: "rowid", register: row.p2 };
  }
  return undefined;
}

// Opcodes that move a cursor to a row. A cursor one of these moves inside a
// loop's body is a nested loop's or a lookup's, so its columns change per
// entry of the outer loop.
export const POSITIONING = new Set([
  ...WALK_START_OPCODES,
  "Next",
  "Prev",
  "NotExists",
  "SeekRowid",
  "DeferredSeek",
  "NullRow",
  "Found",
  "NotFound",
]);

// Opcodes whose p2 is a jump target; any other opcode falls through only.
const JUMPS = new Set([
  ...REJECTING_JUMPS,
  ...STRUCTURAL_JUMPS,
  ...OTHER_JUMPS,
]);

// The instructions control can pass to from `row`. A Gosub or a Yield runs
// code elsewhere and comes back to the next instruction, so it is an edge to
// that instruction here, and callEffect accounts for what the code it runs
// writes.
export function successors(row: BytecodeRow): number[] {
  switch (row.opcode) {
    case "Goto":
    case "Init":
      return [row.p2];
    // A Return with p3 set falls through when its register holds no return
    // address, as it does where BeginSubrtn opens a subquery coded in line.
    case "Return":
      return row.p3 === 1 ? [row.addr + 1] : [];
    case "Halt":
    case "EndCoroutine":
      return [];
    case "Jump":
      return [row.p1, row.p2, row.p3];
    case "Gosub":
      return [row.addr + 1];
    case "InitCoroutine":
      return row.p2 === 0 ? [row.addr + 1] : [row.p2];
    case "Yield":
      return row.p2 === 0 ? [row.addr + 1] : [row.addr + 1, row.p2];
    default:
      return JUMPS.has(row.opcode) ? [row.addr + 1, row.p2] : [row.addr + 1];
  }
}

// The literal a constant write puts in its register, as a filter key reads it,
// or undefined for one with no readable value.
export function literalValue(row: BytecodeRow): string | undefined {
  switch (row.opcode) {
    case "Integer":
      return String(row.p1);
    case "Int64":
    case "Real":
      return row.p4 ?? undefined;
    case "String8":
    case "String":
      return row.p4 === null ? undefined : `'${row.p4}'`;
    case "Null":
      return "NULL";
    default:
      return undefined;
  }
}

// A comparison's opcode with its operands swapped, so a filter keys the same
// whichever side of the comparison the sought row's column was written on.
export const MIRRORED: Readonly<Record<string, string>> = {
  Eq: "Eq",
  Ne: "Ne",
  Lt: "Gt",
  Gt: "Lt",
  Le: "Ge",
  Ge: "Le",
};
