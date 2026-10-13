import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, resetDb, makeUser, api, db } from './helpers.mjs';

before(async () => { await resetDb(); await startServer(); });
after(async () => { await stopServer(); });

async function publishedCourseWithQuiz(admin) {
  const course = await api('/courses', { method: 'POST', token: admin.token, body: { title: 'Authz Course', description: 'd', status: 'published' } });
  const courseId = course.body.id;
  const asm = await api(`/courses/${courseId}/assessments`, {
    method: 'POST', token: admin.token,
    body: {
      title: 'Authz Quiz', type: 'quiz', status: 'published', max_attempts: 1, time_limit_seconds: 600,
      questions: [{ prompt: '2+2?', options: ['3', '4'], correctOptionIds: [1], points: 1, explanation: 'because' }]
    }
  });
  return { courseId, assessmentId: asm.body.id };
}

test('F-03: student quiz payload omits answer key; unenrolled blocked; admin sees full bank', async () => {
  const admin = await makeUser('admin');
  const { courseId } = await publishedCourseWithQuiz(admin);

  const enrolled = await makeUser('student');
  await api(`/courses/${courseId}/enroll/${enrolled.id}`, { method: 'POST', token: admin.token });

  // enrolled student: questions present but NO answer key
  const stu = await api(`/agent/quizzes/${courseId}`, { token: enrolled.token });
  assert.equal(stu.status, 200, `student fetch: ${stu.status} ${JSON.stringify(stu.body)}`);
  const q = stu.body[0].questions[0];
  assert.ok(q.prompt || q.text, 'student sees the prompt');
  assert.equal(q.correctOptionIds, undefined, 'F-03: correctOptionIds must NOT be exposed to students');
  assert.equal(q.correct_answer, undefined, 'F-03: correct_answer must NOT be exposed');
  assert.equal(q.explanation, undefined, 'F-03: explanation must NOT be exposed');
  assert.ok(!JSON.stringify(stu.body).includes('correctOptionIds'), 'F-03: no answer key anywhere in student payload');

  // unenrolled student: 403
  const outsider = await makeUser('student');
  const denied = await api(`/agent/quizzes/${courseId}`, { token: outsider.token });
  assert.equal(denied.status, 403, `unenrolled must be 403, got ${denied.status}`);

  // admin: full bank including answer key
  const adm = await api(`/agent/quizzes/${courseId}`, { token: admin.token });
  assert.equal(adm.status, 200);
  assert.ok(adm.body[0].questions[0].correctOptionIds, 'admin/instructor may see the answer key');
});

test('F-06: quiz results are bound to the authenticated user; client student_id ignored; score clamped', async () => {
  const victim = await makeUser('student');
  const attacker = await makeUser('student');

  // attacker tries to record a score for the victim, and inflate beyond total
  const res = await api('/agent/quizzes/results', {
    method: 'POST', token: attacker.token,
    body: { student_id: victim.id, task_id: 'forgery', score: 999, total: 5 }
  });
  assert.equal(res.status, 200, `results post: ${res.status}`);

  // DB truth: the row belongs to the ATTACKER (req.user.id), not the victim, and score is clamped to total
  const rows = (await db().query('SELECT student_id, score, total FROM quiz_results WHERE task_id = $1', ['forgery'])).rows;
  assert.equal(rows.length, 1);
  assert.equal(String(rows[0].student_id), String(attacker.id), 'F-06: score must be recorded for the caller, not the forged student_id');
  assert.equal(Number(rows[0].score), 5, 'F-06: score must be clamped to total (no inflation above max)');

  // victim's completed list must NOT contain the forged task
  const victimCompleted = await api(`/agent/quizzes/completed/${victim.id}`, { token: victim.token });
  assert.ok(!victimCompleted.body.completed_tasks.some((t) => t.task_id === 'forgery'), 'F-06: victim must not show the forged result');
});

test('F-05: completed-quizzes endpoint is scoped to the caller (no cross-user read)', async () => {
  const a = await makeUser('student');
  const b = await makeUser('student');
  // give B a real result
  await api('/agent/quizzes/results', { method: 'POST', token: b.token, body: { task_id: 'b-private', score: 4, total: 5 } });

  // A asks for B's id -> must get A's own (empty), never B's private result
  const aSeesB = await api(`/agent/quizzes/completed/${b.id}`, { token: a.token });
  assert.equal(aSeesB.status, 200);
  assert.ok(!aSeesB.body.completed_tasks.some((t) => t.task_id === 'b-private'), 'F-05: A must not read B\'s results');

  // B sees their own
  const bSeesSelf = await api(`/agent/quizzes/completed/${b.id}`, { token: b.token });
  assert.ok(bSeesSelf.body.completed_tasks.some((t) => t.task_id === 'b-private'), 'B sees their own result');
});

test('F-05: GET /attempts/:id is owner-scoped (cross-user attempt read denied)', async () => {
  const admin = await makeUser('admin');
  const { courseId, assessmentId } = await publishedCourseWithQuiz(admin);
  const owner = await makeUser('student');
  await api(`/courses/${courseId}/enroll/${owner.id}`, { method: 'POST', token: admin.token });
  const start = await api(`/assessments/${assessmentId}/start`, { method: 'POST', token: owner.token });
  const submissionId = start.body.submissionId || start.body.id;

  const other = await makeUser('student');
  const denied = await api(`/attempts/${submissionId}`, { token: other.token });
  assert.equal(denied.status, 404, `F-05: other user must get 404, got ${denied.status}`);
  const allowed = await api(`/attempts/${submissionId}`, { token: owner.token });
  assert.equal(allowed.status, 200, 'owner can read their own attempt');
});

test('F-07: chat-session deletion is ownership-checked', async () => {
  const ownerA = await makeUser('student');
  const attackerB = await makeUser('student');
  // create a session owned by A directly (avoids depending on the LLM provider)
  const sess = (await db().query('INSERT INTO chat_sessions (user_id, course_id) VALUES ($1, NULL) RETURNING id', [ownerA.id])).rows[0];

  const byOther = await api(`/agent/session/${sess.id}`, { method: 'DELETE', token: attackerB.token });
  assert.equal(byOther.status, 404, `F-07: non-owner delete must be 404, got ${byOther.status}`);
  const stillThere = (await db().query('SELECT id FROM chat_sessions WHERE id = $1', [sess.id])).rows;
  assert.equal(stillThere.length, 1, 'F-07: session must survive a non-owner delete attempt');

  const byOwner = await api(`/agent/session/${sess.id}`, { method: 'DELETE', token: ownerA.token });
  assert.equal(byOwner.status, 200, 'owner can delete their own session');
  const gone = (await db().query('SELECT id FROM chat_sessions WHERE id = $1', [sess.id])).rows;
  assert.equal(gone.length, 0, 'session deleted by owner');
});
