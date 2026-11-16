# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please report it
privately via
[GitHub's security advisory feature](https://github.com/curlewlabs-com/d1-query-plan-gate/security/advisories/new).

Do not open a public issue for security vulnerabilities.

## Scope

This is test-time tooling. It runs inside a test suite against the database
binding the suite gives it, and it has no runtime dependencies.

- **SQL it builds.** The plan sweep prefixes each caller-supplied statement
  with `EXPLAIN QUERY PLAN`, and binds placeholder values, so it executes
  nothing the caller did not write. The statistics seed and the rendered
  statistics payload quote every table, index and stat string as an SQL
  literal; the one identifier spliced in unquoted is `bootstrapTable`, which is
  the caller's own configuration.
- **A live database.** `renderStatsSql` produces a payload that rewrites
  `sqlite_stat1` wholesale. Applying it to a production database changes the
  query planner's choices there; that is its purpose, and review of the model
  behind it is the caller's.
