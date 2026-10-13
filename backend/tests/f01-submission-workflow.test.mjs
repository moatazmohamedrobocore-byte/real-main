import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, resetDb, makeUser, api, db } from './helpers.mjs';

before(async () => { await resetDb(); await startServer(); });
after(async () => { await stopServer(); });

// Build a published course + assessment and an enrolled student. Returns ids/tokens.
async function setupQuiz({ maxAttempts = 1, timeLimit = 600, questions } = {}) {
  const admin = await makeUser('admin');
  const student = await makeUser('student');
  const course = await api('/courses', { method: 'POST', token: admin.token, body: { title: 'F01 Course', description: 'd', status: 'published' } });
  assert.equal(course.status, 201, `create course failed: ${JSON.stringify(course.body)}`);
  const courseId = course.body.id;
  const enroll = await api(`/courses/${courseId}/enroll/${student.id}`, { method: 'POST', token: admin.token });
  assert.ok([200, 201].includes(enroll.status), `enroll failed: ${enroll.status} ${JSON.stringify(enroll.body)}`);
  const asm = await api(`/courses/${courseId}/assessments`, {
    method: 'POST', token: admin.token,
    body: {
      title: 'F01 Quiz', type: 'quiz', status: 'published',
      max_attempts: maxAttempts, time_limit_seconds: timeLimit,
      questions: questions || [{ prompt: '2+2?', options: ['3', '4'], correctOptionIds: [1], points: 1 }]
    }
  });
  assert.equal(asm.status, 201, `create assessment failed: ${JSON.stringify(asm.body)}`);
  return { admin, student, courseId, assessmentId: asm.body.id };
}

test('F-01: a freshly started attempt is in_progress with submitted_at NULL (DB-level)', async () => {
  const { student, assessmentId } = await setupQuiz();
  const start = await api(`/assessments/${assessmentId}/start`, { method: 'POST', token: student.token });
  assert.equal(start.status, 201, `start failed: ${JSON.stringify(start.body)}`);
  const submissionId = start.body.submissionId || start.body.id;

  const row = (await db().query('SELECT attempt_status, submitted_at FROM submissions WHERE id = $1', [submissionId])).rows[0];
  assert.equal(row.attempt_status, 'in_progress', `attempt_status=${row.attempt_status}`);
  assert.equal(row.submitted_at, null, `submitted_at must be NULL on a started attempt, got ${row.submitted_at}`);
});

test('F-01: start -> save -> submit finalizes, grades correctly, rejects resubmit, not stuck in_progress', async () => {
  const { student, assessmentId } = await setupQuiz();

  const start = await api(`/assessments/${assessmentId}/start`, { method: 'POST', token: student.token });
  assert.equal(start.status, 201, `start failed: ${JSON.stringify(start.body)}`);
  const submissionId = start.body.submissionId || start.body.id;

  const got1 = await api(`/attempts/${submissionId}`, { token: student.token });
  assert.equal(got1.body.attemptStatus, 'in_progress');
  assert.equal(got1.body.submittedAt, null, 'API must report submittedAt=null before submit');

  const save = await api(`/attempts/${submissionId}/answers`, { method: 'PUT', token: student.token, body: { responses: [{ questionId: 'q-1', value: 1 }] } });
  assert.equal(save.status, 200, `save answers failed: ${JSON.stringify(save.body)}`);

  const submit = await api(`/attempts/${submissionId}/submit`, { method: 'POST', token: student.token, body: {} });
  assert.equal(submit.status, 200, `submit failed: ${submit.status} ${JSON.stringify(submit.body)}`);
  assert.equal(submit.body.score, 100, `correct answer must score 100, got ${submit.body.score}`);

  const got2 = await api(`/attempts/${submissionId}`, { token: student.token });
  assert.equal(got2.body.attemptStatus, 'submitted', `must not be stuck in_progress, got ${got2.body.attemptStatus}`);
  assert.ok(got2.body.submittedAt, 'submittedAt must be set after submit');
  assert.equal(got2.body.gradingStatus, 'auto_graded');
  assert.equal(Number(got2.body.score), 100);

  const resub = await api(`/attempts/${submissionId}/submit`, { method: 'POST', token: student.token, body: {} });
  assert.equal(resub.status, 409, `resubmit must be rejected with 409, got ${resub.status}`);
});

test('F-01: wrong answer grades 0; empty submission is pending (never auto-100)', async () => {
  const { student, assessmentId } = await setupQuiz();

  // wrong answer -> 0
  const s1 = await api(`/assessments/${assessmentId}/start`, { method: 'POST', token: student.token });
  const id1 = s1.body.submissionId || s1.body.id;
  await api(`/attempts/${id1}/answers`, { method: 'PUT', token: student.token, body: { responses: [{ questionId: 'q-1', value: 0 }] } });
  const sub1 = await api(`/attempts/${id1}/submit`, { method: 'POST', token: student.token, body: {} });
  assert.equal(sub1.body.score, 0, `wrong answer must score 0, got ${sub1.body.score}`);

  // empty submission (separate student, separate quiz) -> pending, score null
  const ctx2 = await setupQuiz();
  const s2 = await api(`/assessments/${ctx2.assessmentId}/start`, { method: 'POST', token: ctx2.student.token });
  const id2 = s2.body.submissionId || s2.body.id;
  const sub2 = await api(`/attempts/${id2}/submit`, { method: 'POST', token: ctx2.student.token, body: {} });
  assert.equal(sub2.status, 200);
  assert.equal(sub2.body.score, null, `empty submission must not be auto-graded, got ${sub2.body.score}`);
  const got = await api(`/attempts/${id2}`, { token: ctx2.student.token });
  assert.equal(got.body.gradingStatus, 'pending', `empty submission gradingStatus=${got.body.gradingStatus}`);
});
