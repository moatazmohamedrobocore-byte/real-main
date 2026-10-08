# Web application

> ## ⚠️ COMPILED OUTPUT — NOT SOURCE. EDITS HERE ARE NOT DURABLE.
>
> Everything under `assets/` is **Rolldown-compiled, hashed, minified** JavaScript/CSS.
> There is **no frontend source code** in this repository or its git history, and **no
> source maps** were emitted, so these files cannot be traced back to `.tsx`.
>
> - **Do not** hand-edit files in `assets/` unless you are deliberately applying a
>   temporary hot-fix to compiled output. Such edits are **lost on any real rebuild**.
> - **Do not** add a build step that writes to `assets/` until a verified source project
>   exists to replace it (see Phase 4 of the frontend-reconstruction plan).
> - Every hand-edit made so far is recorded in
>   [`../../frontend-patches/patch-registry.md`](../../frontend-patches/patch-registry.md).
>   Re-apply those as real source changes when the source project is rebuilt.
> - Investigation + build fingerprint (React 19.2.7, Rolldown, react-router, Tailwind,
>   GSAP, KaTeX): [`../../docs/frontend-source-investigation.md`](../../docs/frontend-source-investigation.md).
> - Last known-good compiled snapshot: git tag `frontend-compiled-snapshot-2026-10-08`
>   (restore with `git checkout frontend-compiled-snapshot-2026-10-08`).

This folder contains the existing compiled static frontend. Its HTML files, assets, fonts,
and images stay together so their relative URLs continue to work when served as a static
site by the Express backend (`backend/server.js` serves this directory and falls back to
`index.html` for SPA routing).
