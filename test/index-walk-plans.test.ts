import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  explainIndexWalks,
  keyGroupId,
  qKeyGroups,
  type KeyGroupContext,
  type NamedQuery,
} from "../src/index";

const groups: KeyGroupContext = {
  userTableNames: new Set(["jobs"]),
  uniqueIndexNames: new Set(),
  nullableKeyIndexNames: new Set(),
  partialIndexPredicates: new Map(),
  indexNamedColumnCounts: new Map([["queue_time", 2]]),
};

beforeAll(async () => {
  await env.DB.exec(
    [
      "CREATE TABLE jobs (id INTEGER PRIMARY KEY, queue INTEGER, created INTEGER, score AS (created+1), ready INTEGER)",
      "CREATE INDEX queue_time ON jobs(queue, created)",
      "CREATE TABLE queues (id INTEGER PRIMARY KEY, cutoff INTEGER)",
      "CREATE TABLE edges (id INTEGER PRIMARY KEY, src INTEGER, dst INTEGER, active INTEGER, visible INTEGER)",
      "CREATE INDEX outgoing ON edges(src, dst)",
      "CREATE INDEX incoming ON edges(dst)",
    ].join(";\n"),
  );
});

async function walk(sql: string, bindCount = 0) {
  const result = await explainIndexWalks(env.DB, [
    ["sample", { sql, bindCount }],
  ]);
  return result.get("sample")!.filter((row) => row.residual !== undefined);
}

describe("post-seek filters", () => {
  it("separates identical plan text into independently reviewable groups", async () => {
    const queries: NamedQuery[] = ["", " AND ready = 1", " AND ready = ?"].map(
      (filter, i) => [
        String(i),
        {
          sql: `SELECT * FROM jobs WHERE queue = ?${filter} ORDER BY created LIMIT 1`,
          bindCount: i === 2 ? 2 : 1,
        },
      ],
    );
    const plans = await explainIndexWalks(env.DB, queries);
    const plain = plans.get("0")![0]!.detail;
    expect([...plans.values()].map((rows) => rows[0]!.detail)).toEqual([
      plain,
      plain,
      plain,
    ]);
    expect(
      queries.flatMap(([name, query]) =>
        qKeyGroups(query.sql, plans.get(name)!, groups).map(keyGroupId),
      ),
    ).toEqual([
      "jobs | queue_time | (queue=?)",
      "jobs | queue_time | (queue=?) | filters ready(Ne 1)",
      "jobs | queue_time | (queue=?) | filters ready(Ne ?)",
    ]);
  });

  it("pairs repeated seeks on the same index with their own comparisons", async () => {
    const term = (op: string) =>
      `(SELECT MAX(created) FROM jobs WHERE queue=? AND id ${op} ?)`;
    const rows = await walk(`SELECT ${term("!=")}, ${term("<")}`, 4);
    expect(rows.map((r) => r.residual)).toEqual([
      ["rowid(Eq ?)"],
      ["rowid(Ge ?)"],
    ]);
  });

  it("attributes shared rejections to each OR arm and excludes deduplication", async () => {
    const rows = await walk(
      `SELECT COUNT(CASE WHEN dst > 0 THEN id END) FROM edges
      WHERE active = 1 AND ((src = ? AND visible = 1) OR dst = ?)
      AND (SELECT cutoff FROM queues WHERE id = 1) = 0`,
      2,
    );
    expect(rows.map((r) => r.residual)).toEqual([
      ["<expr>(Ne 0)", "active(Ne 1)", "visible(Ne 1)"],
      ["<expr>(Ne 0)", "active(Ne 1)"],
    ]);
  });

  it("distinguishes an outer column from an expression with multiple reaching values", async () => {
    const query = (
      value: string,
    ) => `SELECT (SELECT 1 FROM jobs AS j WHERE j.queue=q.id
      AND j.created > ? AND ${value} <= q.cutoff LIMIT 1) FROM queues q`;
    expect((await walk(query("j.ready"), 1))[0]?.residual).toEqual([
      "ready(Gt queues.cutoff)",
    ]);
    expect(
      (
        await walk(
          query("CASE WHEN j.ready=2 THEN j.created ELSE q.cutoff END"),
          1,
        )
      )[0]?.residual,
    ).toEqual(["<expr>(Lt <expr>)"]);
  });

  it("keeps arithmetic and correlated subquery rejections visible", async () => {
    const rows = await walk(
      `SELECT COUNT(*) FROM jobs j WHERE j.queue=? AND j.created - 60 > ?
      AND NOT EXISTS (SELECT 1 FROM edges WHERE active=1 AND src=j.ready)`,
      2,
    );
    expect(rows[0]?.residual).toEqual(expect.arrayContaining(["<expr>(Le ?)"]));
    expect(rows[0]?.residual).toHaveLength(2);
  });
});
