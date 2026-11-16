# Contributing

Use the Bun release named in `.github/workflows/ci.yml`. Keep changes on a
branch and open a pull request with the behavior change and the evidence that
it works.

## Local checks

```sh
bun install --frozen-lockfile
bun run format:check
bun run typecheck
bun run test
```

The tests run inside workerd through `@cloudflare/vitest-plugin`, with an
in-process D1 database; they need no Cloudflare account.

## What a change owes

- A test for the behavior it adds or fixes, on D1 when the behavior depends on
  what D1 prints or plans.
- Comments that say why, not what.
- Exact versions for every dependency, and a commit SHA for every third-party
  action.

Curlew Labs maintains this project. Fixed version tags and published release
assets are never replaced.
