# Upstream touchpoints

Every upstream file this fork edits, why, and what to check when merging an upstream release.
Each edit in code is marked with a `// GATEWAY:` comment. Search for it to find them all:

```sh
git grep -n "GATEWAY:" -- server client
```

Our own code lives in `server/src/gateway/` and `server/src/__tests__/gateway/`; it never conflicts with upstream.

| File | Edit | Why | Added in |
|---|---|---|---|
| _(none yet)_ | | | |

Planned (see [PLAN.md](PLAN.md) §6): `server/src/app.ts` (mount the gate first and the post-parse hook), `server/src/index.ts` (admin listener, gateway bootstrap, graceful shutdown).
