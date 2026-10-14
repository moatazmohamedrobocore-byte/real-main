import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
// Must be set BEFORE the server is spawned: helpers.startServer() inherits process.env.
process.env.REQUIRE_ATTEMPT_FOR_TIMED = 'true';
const { startServer, stopServer, resetDb, makeUser, api } = await import('./helpers.mjs');

before(async () => { await resetDb(); await startServer(); });
after(async () => { await stopServer(); });

test('F-09 (REQUIRE_ATTEMPT_FOR_TIMED=true): timed quizzes need a server-side start; the server then owns the clock', async () => {
  const admin = await makeUser('admin');
  const course = await api('/courses', { method: 'POST', token: admin.token, body: { title: 'Req', description: 'd', status: 'published' } });
  const courseId = course.body.id;
  const asm = (await api(`/courses/${courseId}/assessments`, { method: 'POST', token: admin.token, body: {
    title: 'Timed', type: 'quiz', status: 'published', questions: [{ id: 'q1', type: 'mcq', prompt: '2+2?', options: ['3', '4'], correctOptionIds: [1], points: 1 }]
  } })).body.id;
  const stu = await makeUser('student');
  await api(`/courses/${courseId}/enroll/${stu.id}`, { method: 'POST', token: admin.token });

  const noStart = await api(`/assessments/${asm}/submit`, { method: 'POST', token: stu.token, body: { answers: [{ questionId: 'q1', value: 1 }] } });
  assert.equal(noStart.status, 409);
  assert.equal(noStart.body.error.code, 'ATTEMPT_REQUIRED');

  assert.equal((await api(`/assessments/${asm}/start`, { method: 'POST', token: stu.token })).status, 201);
  const ok = await api(`/assessments/${asm}/submit`, { method: 'POST', token: stu.token, body: { answers: [{ questionId: 'q1', value: 1 }] } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.score, 100);
});
