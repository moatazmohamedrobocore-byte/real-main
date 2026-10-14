import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, resetDb, makeUser, api } from './helpers.mjs';

before(async () => { await resetDb(); await startServer(); });
after(async () => { await stopServer(); });

// Cost-class regression for the AI rate limiter.
// The compiled quiz page fetches /agent/quizzes/<courseId> for EVERY course on every
// render (~150 requests). When those cheap DB reads shared the strict 20/min AI budget,
// one page load permanently starved quiz generation (every /ai/quizzes POST -> 429).
test('cheap quiz-state reads do not consume the AI budget', async () => {
  const stu = await makeUser('student');
  const codes = [];
  for (let i = 0; i < 150; i++) {
    const r = await api(`/agent/quizzes/${'00000000-0000-4000-8000-00000000000' + (i % 10)}`, { token: stu.token });
    codes.push(r.status);
  }
  assert.ok(!codes.includes(429), `cheap reads were AI-throttled (${codes.filter((c) => c === 429).length}x429)`);

  // The expensive AI path is still immediately available after that burst.
  const admin = await makeUser('admin');
  const gen = await api(`/courses/${'00000000-0000-4000-8000-000000000001'}/ai/materials`, {
    method: 'POST', token: admin.token, body: {}
  });
  assert.notEqual(gen.status, 429, 'a page-load burst must not starve AI generation');
});

test('the strict AI budget still applies to expensive AI paths', async () => {
  const admin = await makeUser('admin');
  let saw429 = false;
  for (let i = 0; i < 30; i++) {
    const r = await api(`/courses/${'00000000-0000-4000-8000-000000000002'}/ai/materials`, {
      method: 'POST', token: admin.token, body: {}
    });
    if (r.status === 429) { saw429 = true; break; }
  }
  assert.ok(saw429, 'expensive AI paths must stay rate-limited (20/min)');
});
