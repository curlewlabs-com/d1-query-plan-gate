// The branches that can reject an index entry on the way back to its loop
// step. A per-entry subroutine belongs to the calling seek only when control
// returns straight to that step. The caller also supplies the register values
// live on entry to the subroutine.

import { successors, type BytecodeRow } from "./sqlite-opcodes";

function calledBody(program: readonly BytecodeRow[], call: BytecodeRow) {
  const subroutine = new Set<BytecodeRow>();
  const returns: number[] = [];
  const pending = [call.p2];
  for (let addr = pending.pop(); addr !== undefined; addr = pending.pop()) {
    const op = program[addr];
    if (op === undefined || subroutine.has(op)) continue;
    subroutine.add(op);
    // An inline scalar subquery has its own Return and falls through
    // to the WHERE test. Only the caller's register resumes this arm.
    if (op.opcode === "Return" && op.p1 === call.p1) {
      returns.push(op.addr);
    } else {
      pending.push(...successors(op));
    }
  }
  return { subroutine, returns };
}

export function loopRejections(
  program: readonly BytecodeRow[],
  step: BytecodeRow,
  predecessors: ReadonlyMap<number, readonly BytecodeRow[]>,
) {
  const body = new Set(program.slice(step.p2, step.addr));
  const jumps = new Set<BytecodeRow>();
  const calls = new Map<number, BytecodeRow[]>();
  const seenCalls = new Set<number>();

  function collect(scope: Set<BytecodeRow>, exits: number[]): void {
    const visited = new Set<number>();
    for (let addr = exits.pop(); addr !== undefined; addr = exits.pop()) {
      if (visited.has(addr)) continue;
      visited.add(addr);
      for (const row of predecessors.get(addr) ?? []) {
        const prev = row.addr;
        if (!scope.has(row)) continue;
        if (
          row.opcode === "Goto" ||
          row.opcode === "Noop" ||
          row.opcode === "Explain"
        ) {
          exits.push(prev);
        } else if (row.opcode === "Gosub") {
          if (seenCalls.has(prev)) continue;
          seenCalls.add(prev);
          const callers = calls.get(row.p2) ?? [];
          callers.push(row);
          calls.set(row.p2, callers);
          const { subroutine, returns } = calledBody(program, row);
          for (const op of subroutine) body.add(op);
          collect(subroutine, returns);
        } else if (row.opcode === "Jump" || row.p2 === addr) {
          jumps.add(row);
        }
      }
    }
  }

  collect(new Set(body), [step.addr]);
  return { body, jumps, calls };
}
