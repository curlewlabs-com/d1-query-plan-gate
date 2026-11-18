import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import {
  UNPLANNABLE,
  explainAll,
  acknowledgementDrift,
  measuredMoves,
  movedQueries,
  planSweep,
  renderPlan,
  renderPlanMovesModule,
  unplannableQueries,
  type NamedQuery,
} from "../src/index";

const PROBE_DDL = [
  "DROP TABLE IF EXISTS plan_delta_probe",
  "CREATE TABLE plan_delta_probe (id INTEGER PRIMARY KEY, tag TEXT NOT NULL) STRICT",
];

const PROBE_QUERIES: NamedQuery[] = [
  ["PROBE_BY_TAG", { sql: "SELECT id FROM plan_delta_probe WHERE tag = 'x'" }],
];

// The caller's half of a sweep: put the database on the schema under test.
async function sweep(
  extraDdl: readonly string[],
  queries: readonly NamedQuery[] = PROBE_QUERIES,
): Promise<Map<string, string>> {
  await env.DB.batch(
    [...PROBE_DDL, ...extraDdl].map((sql) => env.DB.prepare(sql)),
  );
  return planSweep(env.DB, queries);
}

describe("plan delta", () => {
  // The control every acknowledged name rests on: independent builds of ONE
  // schema, swept the same way, must render identically - otherwise a
  // rebuild's own variation reaches the diff and the reviewer reads noise.
  it("reports nothing when both sweeps are the same schema", async () => {
    const before = await sweep([]);
    const after = await sweep([]);
    expect(movedQueries(before, after)).toEqual([]);
  });

  // The arm: a sweep that quietly stopped comparing would agree with an empty
  // table forever, and the control above would agree with it.
  it("reports a query an added index re-points", async () => {
    const before = await sweep([]);
    const after = await sweep([
      "CREATE INDEX idx_plan_delta_probe_tag ON plan_delta_probe(tag)",
    ]);

    expect(movedQueries(before, after)).toEqual(["PROBE_BY_TAG"]);
    expect(after.get("PROBE_BY_TAG")).toContain("idx_plan_delta_probe_tag");
  });

  // D1 in the test runtime reuses a prepared statement by its text, and a
  // reused EXPLAIN keeps the plan it was prepared under when a delta only
  // removes an index. A delta that drops an index would then report nothing,
  // and every query that rode it would move unreviewed.
  it("reports a query whose index the delta removes", async () => {
    const before = await sweep([
      "CREATE INDEX idx_plan_delta_probe_dropped ON plan_delta_probe(tag)",
    ]);
    const after = await sweep([]);

    expect(before.get("PROBE_BY_TAG")).toContain(
      "idx_plan_delta_probe_dropped",
    );
    expect(movedQueries(before, after)).toEqual(["PROBE_BY_TAG"]);
    expect(after.get("PROBE_BY_TAG")).toBe("SCAN plan_delta_probe");
  });

  // An index revised after its pair was reviewed keeps every name in the moved
  // set, so a message keyed on names would point at no query while the table
  // fails. `read` is what was reviewed and `revised` what the delta became;
  // swapping `revised` into the first argument covers the predecessor side.
  it("rejects an acknowledgement once either plan of its pair changes", async () => {
    const before = await sweep([]);
    const read = await sweep([
      "CREATE INDEX idx_plan_delta_probe_read ON plan_delta_probe(tag)",
    ]);
    const revised = await sweep([
      "CREATE INDEX idx_plan_delta_probe_revised ON plan_delta_probe(tag)",
    ]);
    const names = movedQueries(before, read);
    const acknowledged = measuredMoves(names, before, read);

    expect(movedQueries(before, revised)).toEqual(names);
    expect(
      acknowledgementDrift(measuredMoves(names, before, read), acknowledged),
    ).toEqual({ unacknowledged: [], stale: [], changed: [] });
    expect(
      acknowledgementDrift(measuredMoves(names, before, revised), acknowledged),
    ).toEqual({ unacknowledged: [], stale: [], changed: ["PROBE_BY_TAG"] });
    expect(
      acknowledgementDrift(measuredMoves(names, revised, read), acknowledged),
    ).toEqual({ unacknowledged: [], stale: [], changed: ["PROBE_BY_TAG"] });
    expect(acknowledgementDrift({}, acknowledged)).toEqual({
      unacknowledged: [],
      stale: ["PROBE_BY_TAG"],
      changed: [],
    });
  });

  // A query reading a column the delta adds has no predecessor plan, and an
  // entry records D1's error for it. That error can carry a byte offset into
  // the SQL, so keyed on the raw message an edit to the column list would
  // demand a fresh read of a pair the edit did not touch. Against real D1
  // because the message format is D1's.
  it("records the same unplannable reason wherever the column sits in the SQL", async () => {
    const before = await sweep(
      [],
      [
        ["NEAR", { sql: "SELECT added FROM plan_delta_probe" }],
        ["FAR", { sql: "SELECT id, tag, added FROM plan_delta_probe" }],
      ],
    );

    expect(before.get("NEAR")).toContain("no such column: added");
    expect(before.get("FAR")).toBe(before.get("NEAR"));
  });

  // The batch is one transaction, so one unpreparable member aborts it; the
  // fallback walk must still plan every other query and pin the failure on the
  // right name, or a broken query would hide its neighbours' moves.
  it("attributes an unpreparable query by name and still plans the rest", async () => {
    const plans = await sweep(
      [],
      [
        ...PROBE_QUERIES,
        ["BROKEN", { sql: "SELECT missing FROM plan_delta_probe" }],
        [
          "BOUND",
          { sql: "SELECT id FROM plan_delta_probe WHERE id = ?", bindCount: 1 },
        ],
      ],
    );

    expect(plans.get("PROBE_BY_TAG")).toContain("SCAN plan_delta_probe");
    expect(plans.get("BOUND")).toContain("SEARCH plan_delta_probe");
    expect(plans.get("BROKEN")!.startsWith(UNPLANNABLE)).toBe(true);
    expect(unplannableQueries(plans)).toEqual([
      `BROKEN: ${plans.get("BROKEN")}`,
    ]);
  });

  // The VDBE addresses shift whenever a delta grows a statement's program; the
  // rendering must keep the nesting they encode and nothing else.
  it("renders nesting from parent links without the addresses", () => {
    const shape = (base: number) =>
      renderPlan([
        { id: base + 2, parent: 0, detail: "SCAN t" },
        { id: base + 5, parent: 0, detail: "SCALAR SUBQUERY 1" },
        {
          id: base + 9,
          parent: base + 5,
          detail: "SEARCH u USING INDEX i (a=?)",
        },
      ]);

    expect(shape(0)).toBe(
      "SCAN t\nSCALAR SUBQUERY 1\n  SEARCH u USING INDEX i (a=?)",
    );
    expect(shape(40)).toBe(shape(0));
  });

  // The committed table is compared byte for byte, so it must be a module the
  // caller can import back and get the measured moves from.
  it("renders a module whose table is the measured moves", () => {
    const measured = {
      Q: { before: ["SCAN t"], after: ["SEARCH t USING INDEX i (a=?)"] },
    };
    const text = renderPlanMovesModule(measured, {
      preamble: '// generated\nimport type { PlanMove } from "./plan-move";\n',
    });

    expect(text.startsWith("// generated\nimport type")).toBe(true);
    expect(text.endsWith(";\n")).toBe(true);
    const literal = text.slice(text.indexOf("= ") + 2, -2);
    expect(JSON.parse(literal)).toEqual(measured);
  });

  // Plans are keyed by name, so a repeated name would let a working query's
  // plan replace a broken one's.
  it("refuses repeated query names", async () => {
    const repeated: NamedQuery[] = [
      ["SAME", { sql: "SELECT missing FROM plan_delta_probe" }],
      ["SAME", { sql: "SELECT id FROM plan_delta_probe" }],
    ];
    await expect(sweep([], repeated)).rejects.toThrow("repeated: SAME");
    await expect(explainAll(env.DB, repeated)).rejects.toThrow(
      "repeated: SAME",
    );
  });
});
