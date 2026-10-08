# Frontend Source Investigation — 2026-10-08

Goal: determine whether a real, buildable source-of-truth for the `apps/web/` frontend
exists anywhere, so in-place edits to compiled bundles stop being the only option.

## Verdict

**No frontend source exists in this repository, its git history, or its build output.**
The compiled bundles were committed as-is. Recovery from source maps is **impossible**
(none were emitted). The only remaining avenues are **external** (another GitHub repo, or
an AI app-builder project export) and require the user to check accounts this agent cannot
access.

## Evidence (all verified)

### 1. Source maps — ABSENT
- `grep -rl "sourceMappingURL" apps/web/` → **0 files**. No bundle has a
  `//# sourceMappingURL=` comment.
- `find . -name "*.map"` (excluding node_modules) → **0 files**.
- Conclusion: Rolldown was run **without** `sourcemap: true`. There is no `sourcesContent`
  to extract. Requesting `<bundle>.js.map` on the live site would 404 — the build never
  produced them. Lossless `.tsx` recovery via maps is **off the table**.

### 2. Git archaeology — NO SOURCE, EVER
- Branches: only `main` (+ `origin/main`). Tags: none before today. Stashes: none.
- `git log --all --diff-filter=D --name-only -- '*.tsx' '*.jsx'` → **empty** (no source ever
  deleted, because none was ever added).
- `git log --all -S"createRoot"` → matches **only** `apps/web/assets/index-BOtlBGmE.js` and
  `vendor-react-CeZ512P1.js` (compiled bundles), never a source file.
- `git log --all -- '*vite.config*'` → **empty**. No Vite/Rolldown config ever committed.
- First commit `c7e0f7b` (196 files): `apps/web/` already contained only compiled
  `assets/` + HTML + fonts. No `src/`, no `.tsx`, no `.jsx`.
- `.gitignore` does **not** list `src/`, `*.tsx`, or `*.jsx` — source was not ignored; it was
  simply never present.
- `apps/web/README.md` (original): "This folder contains the **existing compiled static
  frontend**." — i.e. it was dropped in pre-built.

### 3. Architecture drift in history
- First commit `c7e0f7b` had a **different backend**: `services/core-api/` (Node, DDD-style
  `src/domains/…`) + `services/ai-service/` (Python `main.py`), with MongoDB
  (`mongodb-memory-server` in devDeps). That `services/` tree was **removed** from the working
  tree (task "Remove MongoDB services"); the current backend is the flat `backend/`
  Express+Postgres app. The frontend bundles predate and outlived this swap — further evidence
  they are external artifacts, not built from in-repo source.

### 4. External avenues — CANNOT VERIFY FROM HERE
- `gh` CLI is **not installed** (`gh: command not found`), so the other repos under
  `moatazmohamedrobocore-byte` (and the prior `moatazmohamedcr852-png/real_i_main` remote)
  could not be listed or searched.
- No browser session to those GitHub accounts or to any AI app-builder (Lovable / Bolt / v0 /
  Replit) dashboard.
- **Action required from user** (see Phase 3 report).

## Build fingerprint (for any reconstruction)

Read from bundle headers, `index.html`, and inlined code:

| Concern | Value | Evidence |
|---|---|---|
| UI lib | **React 19.2.7** | version string in `vendor-react-CeZ512P1.js` |
| Bundler | **Rolldown** (Vite's Rust bundler) | `rolldown-runtime-QTnfLwEv.js`; `modulepreload` in index.html |
| Router | **react-router** data router (`RouterProvider`, `useScrollRestoration`, `useViewTransitionState`) | `index-BOtlBGmE.js`; error string references `react-router-dom`'s RouterProvider → v6.4+/v7 |
| CSS | **Tailwind** (custom tokens: `surface-*`, `primary-*`, `accent/danger/warning`, `glass-card`, `animate-slide-up`, `font-arabic`, `font-heading`) | className literals throughout |
| Animation | **GSAP** | `vendor-gsap-CZkpitSS.js` (62 refs) |
| Math | **KaTeX** | `vendor-katex-*.js` + `.css` (14 refs) |
| Icons | **lucide-react**-style (components referenced by minified single letters, `size=` prop) | e.g. `(0,v.jsx)(d,{size:12})` |
| HTTP | **custom wrapper** `Ee`/`r` with `.get/.post/.put`, base `/v1`, token in `localStorage['reali_token']` | `api-DvVeKkjb.js`, AuthProvider in index chunk |
| Fonts | Orbitron, Inter (variable), IBM Plex Mono, Montserrat, Tajawal | `apps/web/fonts/` + index.html preloads |

### App architecture recovered from the bundle (verified by reading `index-BOtlBGmE.js`)
- **Context providers, not Redux/Zustand**: `AuthProvider` (`useAuth`), `ThemeProvider`
  (`useTheme`, `reali_theme`), `SidebarProvider` (`useSidebar`, `reali_sidebar_collapsed`),
  `AssessmentProvider` (`useAssessments`), `ToastProvider` (`useToast`), plus a
  `react-error-boundary`-style `ErrorBoundary` with a "System Exception / Reboot System" fallback.
- **Auth flow**: bootstrap via `GET /auth/me` when `reali_token` present; 30-min idle timer
  (`18e5` ms) → `/login?reason=timeout`; `reali_auth_revoked` window event →
  `/login?reason=session_revoked`; tokens `reali_token` + `reali_refresh_token` in localStorage.
- **Assessment normalization**: an `Ir()` mapper translates snake_case backend fields ↔
  camelCase frontend model (e.g. `course_id`↔`courseId`, `max_attempts`↔`attempts`,
  `shuffle_questions`↔`randomizeQuestions`, options array↔`{A,B,C,D}` object).
- **Route-level code splitting**: 44 screen chunks (`Admin*`, `Student*`, `Live*`, static pages),
  ~1.6 MB total compiled JS.

## Live frontend/backend contract mismatch (must reconcile in any rebuild)
The P0 answer-key fix removed `correct_answer` from `POST /courses/:id/ai/quizzes`. The
compiled `StudentQuiz-D7rIh7I4.js` still reads `t.correct_answer` for instant per-question
feedback; that now resolves to `undefined` (no crash, no instant highlight). Server-side
grading via `POST /ai/quizzes/:quizId/grade` still works and the chunk already calls it on
finish. A source rebuild should drop the client-side `correct_answer` reads entirely and rely
on the `/grade` response (`detail[].isCorrect`, `correctIndex`, `explanation`).
