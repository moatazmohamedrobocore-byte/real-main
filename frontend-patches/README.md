# Frontend Patch Registry

`apps/web/assets/` contains **Rolldown-compiled, hashed, minified bundles**. There is
**no frontend source code** anywhere in this repository or its git history (verified —
see `../docs/frontend-source-investigation.md`). Every frontend fix to date has been an
**in-place edit to compiled output**. Those edits are fragile: a real rebuild from source
would silently erase all of them.

This registry exists so that:
1. Every hand-edit to a compiled bundle is documented and recoverable.
2. If/when a real source project is reconstructed (Phase 4), each patch can be re-applied
   as a proper source change instead of being lost.
3. The current working compiled frontend can always be restored.

## Restore the known-good compiled frontend

A git tag marks the last verified-working state of the compiled bundles + backend:

```
git checkout frontend-compiled-snapshot-2026-10-08
```

That tag points at commit `2abdd14`. Do **not** add any build step that writes to
`apps/web/assets/` until a verified source replacement exists.

## How to read a patch's real diff

Each entry in `patch-registry.md` names a commit and a file. The authoritative before/after
is always retrievable from git:

```
# human-readable changed region within the minified line:
git show <commit> --word-diff=porcelain -- apps/web/assets/<file>.js

# full file diff:
git show <commit> -- apps/web/assets/<file>.js
```

Because the bundles are single-line minified files, a normal `git diff` shows the entire
line as changed. Use `--word-diff` to isolate the small edited region.

## Provenance of this registry

Built 2026-10-08 from git history of `apps/web/assets/*.js` across commits `c2e20cd`,
`559d339`, `5f994b3`, cross-referenced against `QA-REPORT-2026-09-26.html`,
`QA-REPORT-2026-09-30.html`, and `QA-REVALIDATION-2026-09-29.html`. Code changes are
**verified** from git word-diffs; DEF-ID attributions are marked verified or inferred.
