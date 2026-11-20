// The package's public surface: the database interface, plan moves per schema
// delta, the plan lint, and production-shape statistics.

export {
  assertUniqueNames,
  explainAll,
  explainSql,
  explainStatement,
} from "./database";
export type {
  NamedQuery,
  PlanDatabase,
  PlanQuery,
  PlanRow,
  PlanStatement,
} from "./database";
export * from "./index-walk-plans";
export * from "./plan-delta";
export * from "./plan-lint";
export * from "./stats";
