# Tracking upstream

This repo is a GitHub fork of [`tashfeenahmed/freellmapi`](https://github.com/tashfeenahmed/freellmapi). We keep upstream's code as is and add our own on top, so we can keep merging their releases.

## Remotes

| Remote | Points at | Used for |
|---|---|---|
| `origin` | `SmokeNova/ai-gateway` | Our work. Push here. |
| `upstream` | `tashfeenahmed/freellmapi` | Fetch only. Never push. |

One-time setup on a fresh clone:

```sh
git clone git@github.com:SmokeNova/ai-gateway.git && cd ai-gateway
git remote add upstream https://github.com/tashfeenahmed/freellmapi.git
git config remote.upstream.tagOpt --tags     # fetch upstream's release tags
git config remote.origin.tagOpt --no-tags    # never mix them into ours
git config push.followTags false             # never push upstream tags by accident
gh repo set-default SmokeNova/ai-gateway     # gh pr create targets our repo, not upstream
```

## Rules

- `main` = an upstream **release tag** plus our commits. We merge release tags (`v0.16.x`), never upstream's `main`.
- Our releases are tagged `gateway-vX.Y.Z`. Upstream's `v*` tags are never pushed to `origin`.
- Our code stays in `server/src/gateway/`, `server/src/__tests__/gateway/`, `deploy/`, `docs/gateway/`, `.github/README.md` and `.github/workflows/gateway-*.yml`. Edits to upstream files are listed in [UPSTREAM_TOUCHPOINTS.md](UPSTREAM_TOUCHPOINTS.md).

## Merging a new upstream release by hand

The weekly `gateway-upstream-sync.yml` job (M2) does this automatically and opens a PR. By hand:

```sh
git fetch upstream
git tag -l "v*" --sort=-v:refname | head -3       # newest release tags
git switch -c upstream-sync/v0.16.40 main
git merge --no-ff v0.16.40 -m "Merge upstream v0.16.40"
npm ci && npm run build && npm run lint && npm test
git push -u origin upstream-sync/v0.16.40
gh pr create --base main --title "Merge upstream v0.16.40"
```

If the merge conflicts, the conflicts will be in the touchpoint files. Resolve by keeping upstream's change and re-applying our marked `// GATEWAY:` edit.
