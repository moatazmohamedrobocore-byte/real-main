# Patch Registry — in-place edits to compiled frontend bundles

All paths relative to repo root. "Change" columns are **verified** from `git show <commit>
--word-diff`. DEF attribution is marked **[verified]** (stated in a QA report) or
**[inferred]** (from commit message / code semantics).

Retrieve any full diff with:
`git show <commit> --word-diff=porcelain -- apps/web/assets/<file>`

---

## Commit `c2e20cd` — "Fix live sessions, AI quiz generation, and student/admin chat"

| File | Change (before → after) | Why | DEF |
|---|---|---|---|
| `LiveMeetingPage-Co71c9DM.js` | Jitsi init: added `t.getIFrame?.()?.addEventListener?.('load',…)` + a `setTimeout` fallback to clear the loading state | Meeting iframe never fired `videoConferenceJoined`, so the loading spinner hung | [inferred] live-session fix |
| `index-BOtlBGmE.js` | (root chunk) small change accompanying the above | — | [inferred] |

---

## Commit `559d339` — "Fix QA regression defects and remove MongoDB service"

| File | Change (before → after) | Why | DEF |
|---|---|---|---|
| `AdminStudents-DOREZyfv.js` | `B && e.email!==E` → `B` (role-toggle fragment guard) | Admins could not change roles of other users; guard only allowed self-edit | **DEF-07 [verified]** |
| `AdminStudentProfile-C8avtq8J.js` | `useState(!…)` guard relaxed (same DEF-07 family) | Same role-edit restriction on the profile view | **DEF-07 [verified]** |
| `AdminCalendar-CcaJ2SwU.js` | `children:[t.label,'s']` → `children:t.label` | Filter chips rendered "Meetings" as "Meetingss" (naive pluralization) | **DEF-23 [verified]** |
| `StudentCalendar-BewWhaQB.js` | `children:[t.label,'s']` → `children:t.label` | Same pluralization bug on the student calendar | **DEF-23 [verified]** |
| `StudentQuiz-D7rIh7I4.js` | (1) import `gradeAiQuiz as GQ`; (2) `O(e.quiz)` → `O({...e.quiz, quizId:e.quizId||e.id})`; (3) finish handler now builds `an={qId:selected}` and calls `GQ(D.quizId, an)`, reconciling per-question `isCorrect` from `gr.detail` | Move AI-quiz grading server-side so the answer key is not trusted from the client | **DEF-02 [verified]** |
| `ChatInterface-D4JaK2b9.js` | added `onKeyDown:e=>{e.key==='Enter'&&C(e)}` to the shared input | Enter key did not send a chat message | [inferred] chat UX |
| `StudentDashboard-Dgm96vvF.js` | `children:t.project_id` → `children:t.course_title||t.title||t.project_id` | Dashboard showed a raw course UUID instead of the course title | [inferred] DEF-05 family |
| `StudentChat-Db4u3ekg.js` | course picker `label:e.project_id` → `label:e.title||e.project_id` | Picker showed UUIDs instead of course titles | [inferred] |
| `AdminAssessmentCreate-TmYTY6TI.js` | course option `label:e.project_id` → `label:e.title||e.project_id` | Assessment-create course dropdown showed UUIDs | [inferred] |
| `AdminCourses-BQZnqDz1.js` | import `createCourse as CC`; wired "New Course" button to it | New Course button was inert | [inferred] |
| `AdminSettings-DXNQs0ms.js` | import `getSettings as GS, saveSettings as SS`; load/save via API with localStorage fallback | Settings were local-only, never persisted to backend | **DEF-09 [verified]** |
| `AdminUpload-CP6wZG2h.js` | course option `label:e.project_id` → `label:e.title||e.project_id`; no-files guard | Upload screen showed UUIDs; allowed empty submit | [inferred] |
| `LiveMeetingPage-Co71c9DM.js` | nav `to:'/student/dashboard'` → `to:'/student'` | Post-meeting link 404'd (route is `/student`) | [inferred] |
| `api-DvVeKkjb.js` | +5 lines: added exports incl. `gradeAiQuiz` | Support the StudentQuiz server-grading change | **DEF-02 [verified]** |

---

## Commit `5f994b3` — "Complete platform workflows and QA updates"

| File | Change (before → after) | Why | DEF |
|---|---|---|---|
| `api-DvVeKkjb.js` | +62 lines: added `createCourse`, `getSettings`, `saveSettings`, `gradeSubmission`, `openSubmissionFile`, `getMySubmissions`, and alias re-exports | Central API wrapper for new workflows | [inferred] |
| `index-BOtlBGmE.js` | ±6 lines (root chunk: routing/provider adjustments) | — | [inferred] |
| `AdminGradingPage.js` | **NEW FILE (123 lines, hand-written, not compiler output)** — grading UI calling `gradeSubmission`/`openSubmissionFile` | Added an instructor grading screen that did not exist in the original build | [inferred] |
| `AdminAssessmentDetail-DPpSWO_m.js` | import `gradeSubmission as gradeAttempt, openSubmissionFile as openFile` | Wire grading + file open into assessment detail | [inferred] |
| `LoginPage-CStcvtqd.js` | forgot-password now does a real `fetch('/api/auth/forgot-password', …)` instead of only showing a toast | Password reset was a no-op stub | [inferred] auth flow |
| `StudentExamTake-BmL6rfrz.js` | destructure adds `getMySubmission…` from the assessments context | Resume/submit existing attempt | **DEF-01 family [inferred]** |
| `StudentAssessments-Cz9py94q.js` | destructure adds `getMySubmissions:loadMySubmissions` | Show the student's own submissions | [inferred] |
| `StudentAssignmentSubmit-V0-EtsIh.js` | `Array.from(e.target.files||[]).map(e=>e.name)` → `Array.from(e.target.files||[])` (keep `File` objects, not just names) | Files were tracked by name only, so nothing was actually uploaded | [inferred] upload fix |
| `StudentPerformance-DhxPv9Qh.js` | import alias `P` → `B` (getProjects) + map real `progress`/`completed_lessons`/`lesson_count` | Performance view used the wrong API + hardcoded numbers | [inferred] |
| `StudentCourses-xjE8nYXa.js` | import alias `P` → `B` | api.js alias re-export shifted | [inferred] |
| `StudentProfile-9TawEEYy.js` | import alias `B` → `V` | api.js alias re-export shifted | [inferred] |
| `AdminCalendar-CcaJ2SwU.js` | further edit (title/date validation on create) | Event could be created with empty title/date | **DEF-19 [verified]** |
| `AdminCourses-BQZnqDz1.js` | further edit (archive copy correction) | — | [inferred] |
| `AdminUpload-CP6wZG2h.js` | further edit (course titles in labels) | — | [inferred] |
| `AdminAssessmentCreate-TmYTY6TI.js` | step-4 review resolves UUID → title | Review step showed UUIDs | [inferred] |

---

## Backend-only security commits (NO frontend bundle changes)

These are recorded for completeness — they changed **no** compiled bundle, so nothing here
is at risk from a frontend rebuild:

| Commit | Scope |
|---|---|
| `2437d1d` | Quiz positional-bias shuffle (`backend/routes/data.js`) |
| `580c250` | Schema migration ordering fix (`backend/db/schema.sql`) |
| `08716a7` | Four P0 fixes: JWT secrets, CORS, upload traversal, AI answer-key leak (backend only) |
| `2abdd14` | CORS same-origin refactor (`backend/server.js`) |

Note: the **AI answer-key leak fix (P0 #1)** removed `correct_answer` from the backend
quiz response. The compiled `StudentQuiz-D7rIh7I4.js` still contains code paths that read
`t.correct_answer` for instant per-question feedback; with the field now absent those
comparisons evaluate against `undefined` (no crash, but no instant green/red highlight).
Post-submission grading via `GQ()` still works. **This is a live frontend/backend contract
mismatch that a source rebuild must reconcile.** See `../docs/frontend-source-investigation.md`.

---

## Summary

- **3 commits** touched compiled bundles: `c2e20cd`, `559d339`, `5f994b3`.
- **~30 distinct bundle files** hand-edited; **1 hand-written new chunk** (`AdminGradingPage.js`).
- **`api-DvVeKkjb.js`** accumulated ~67 lines of hand-added wrapper functions — the single
  most divergent file from original compiler output.
- All edits are recoverable via git; none are in any source form.

---

## Post-snapshot edits (after tag `frontend-compiled-snapshot-2026-10-08`)

These edits were made AFTER the snapshot tag, so they are NOT captured by it. If you restore
the tag, you lose these — re-apply from git or from this registry.

| File | Change (before → after) | Why | Verified |
|---|---|---|---|
| `LiveMeetingPage-Co71c9DM.js` | (1) mount-effect else branch: `:(b(t.waitingForHost?…))` → `:(ve(t),b(t.waitingForHost?…))` so the `canStart` response is stored in state `S`; (2) `waiting_host` heading/paragraph gated on `S?.canStart` → "No Active Session" / "No live session is running. Start one when you are ready…"; (3) the "Check if Session Started" button wrapped in `S?.canStart ? <Start Session button> : <existing button>`. The Start button's onClick calls `ue({start:true})` (= `authorizeMeetingJoin({start:true})`) and on `authorized` runs the same `ve(t),k(…),b('authorized')` transition as the mount effect. | Clicking sidebar "Live Classes" auto-created + auto-joined a live session. Paired with backend `meetings.js` change that returns `{authorized:false, canStart:true, waitingForHost:true}` for staff with no active session and only creates one when `req.body.start===true`. | ✅ `node --check` ESM parse OK; browser click-through: sidebar → "No Active Session" + "Start Session" button, **no Jitsi auto-load**; clicking Start → Instructor/Moderator command center, session created. |

**Backend counterpart** (not a bundle, but part of the same change): `backend/routes/meetings.js`
`authorizeJoinHandler` — instant session creation now gated behind `req.body.start === true`;
staff with no active session get `{authorized:false, canStart:true, waitingForHost:true}`.
An already-`live` session is still reused/joined on sidebar click (expected "resume" behavior).

---

## Quiz answer reveal (right/wrong + AI explanation) — in-place patch

| File | Change (before → after) | Why | DEF |
|---|---|---|---|
| `StudentQuiz-D7rIh7I4.js` | import `api as AX`; new state `[PD,SPD]`; `oe` (option click) is now async and calls `POST /ai/quizzes/:quizId/answer`, then stores the returned `correct_answer` and `explanation` on the current question before revealing | The generate response no longer contains `correct_answer` / `explanation` (answer-key leak fix), so the page had nothing to show after a student chose an option. The server now reveals one question's result only after that choice is locked in | quiz-feedback regression [verified] |

`backend/server.js` serves `StudentQuiz-*.js` with `Cache-Control: no-cache` (it keeps its old hash). Clients that
already cached the old file need one hard refresh.
