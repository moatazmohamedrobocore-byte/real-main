import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, stopServer, resetDb, makeUser, api, db, BASE } from './helpers.mjs';

before(async () => { await resetDb(); await startServer(); });
after(async () => { await stopServer(); });

const UPLOAD_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'uploads');
const uploadCount = () => (fs.existsSync(UPLOAD_DIR) ? fs.readdirSync(UPLOAD_DIR).length : 0);

async function courseWithQuiz(admin) {
  const course = await api('/courses', { method: 'POST', token: admin.token, body: { title: 'Hardening Course', description: 'd', status: 'published' } });
  const courseId = course.body.id;
  const asm = await api(`/courses/${courseId}/assessments`, {
    method: 'POST', token: admin.token,
    body: { title: 'Hardening Quiz', type: 'quiz', status: 'published', time_limit_seconds: 600,
      questions: [{ prompt: '2+2?', options: ['3', '4'], correctOptionIds: [1], points: 1 }] }
  });
  return { courseId, assessmentId: asm.body.id };
}

async function multipart(p, token, filename = 'notes.txt', text = 'hello') {
  const fd = new FormData();
  fd.append('file', new Blob([text], { type: 'text/plain' }), filename);
  const res = await fetch(`${BASE}${p}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  let body = null; try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

test('F-03: /assessments/student/me never returns the answer key (in progress or submitted)', async () => {
  const admin = await makeUser('admin');
  const { courseId, assessmentId } = await courseWithQuiz(admin);
  const stu = await makeUser('student');
  await api(`/courses/${courseId}/enroll/${stu.id}`, { method: 'POST', token: admin.token });

  const start = await api(`/assessments/${assessmentId}/start`, { method: 'POST', token: stu.token });
  assert.equal(start.status, 201);

  let mine = await api('/assessments/student/me', { token: stu.token });
  assert.equal(mine.status, 200);
  assert.ok(mine.body.length >= 1);
  let raw = JSON.stringify(mine.body);
  for (const k of ['correctOptionIds', 'correct_answer', 'question_snapshot', 'assessment_questions']) {
    assert.ok(!raw.includes(k), `F-03: "${k}" must not appear while the attempt is in progress`);
  }
  assert.ok(mine.body[0].total_marks >= 1, 'total_marks is still computed server-side');

  const submit = await api(`/attempts/${start.body.id}/submit`, { method: 'POST', token: stu.token, body: { responses: [{ questionId: start.body.questions[0].id, value: 1 }] } });
  assert.equal(submit.status, 200, JSON.stringify(submit.body));
  assert.ok(!JSON.stringify(submit.body).includes('correctOptionIds'), 'submit response must not leak the key');
  assert.equal(submit.body.submission.question_snapshot, undefined, 'submit response must not include question_snapshot');

  mine = await api('/assessments/student/me', { token: stu.token });
  raw = JSON.stringify(mine.body);
  assert.ok(!raw.includes('correctOptionIds') && !raw.includes('question_snapshot'), 'F-03: no key after submission either');

  // staff dossier view keeps the data it needs for grading
  const dossier = await api(`/assessments/students/${stu.id}/submissions`, { token: admin.token });
  assert.equal(dossier.status, 200);
});

test('F-05: /users/:id/results is owner-or-admin only', async () => {
  const admin = await makeUser('admin');
  const a = await makeUser('student');
  const b = await makeUser('student');
  assert.equal((await api(`/users/${a.id}/results`, { token: b.token })).status, 403, 'other student denied');
  assert.equal((await api(`/users/${a.id}/results`, { token: a.token })).status, 200, 'owner allowed');
  assert.equal((await api(`/users/${a.id}/results`, { token: admin.token })).status, 200, 'admin allowed');
  assert.equal((await api(`/users/${a.id}/results`)).status, 401, 'anonymous denied');
});

test('F-07: cannot post into another user\'s chat session; own session works', async () => {
  const admin = await makeUser('admin');
  const { courseId } = await courseWithQuiz(admin);
  const owner = await makeUser('student');
  const intruder = await makeUser('student');

  const first = await api(`/courses/${courseId}/ai/chat`, { method: 'POST', token: owner.token, body: { message: 'my private question' } });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const sid = first.body.session_id;
  const countMsgs = async () => Number((await db().query('SELECT count(*) FROM chat_messages WHERE session_id = $1', [sid])).rows[0].count);
  const before = await countMsgs();

  const hijack = await api(`/courses/${courseId}/ai/chat`, { method: 'POST', token: intruder.token, body: { message: 'injected', session_id: sid } });
  assert.equal(hijack.status, 404, 'F-07: foreign session must be 404');
  assert.equal(await countMsgs(), before, 'F-07: no message may be appended to the victim session');

  const bogus = await api(`/courses/${courseId}/ai/chat`, { method: 'POST', token: intruder.token, body: { message: 'x', session_id: 'not-a-uuid' } });
  assert.equal(bogus.status, 404, 'malformed session id is 404, not a 500');

  const own = await api(`/courses/${courseId}/ai/chat`, { method: 'POST', token: owner.token, body: { message: 'follow up', session_id: sid } });
  assert.equal(own.status, 200);
  assert.ok(await countMsgs() > before, 'owner can continue their own session');
});

test('F-13: only admins can upload, list assets, or trigger indexing', async () => {
  const admin = await makeUser('admin');
  const { courseId } = await courseWithQuiz(admin);
  const stu = await makeUser('student');
  await api(`/courses/${courseId}/enroll/${stu.id}`, { method: 'POST', token: admin.token });

  const filesBefore = uploadCount();
  for (const p of [`/data/upload/${courseId}`, '/upload']) {
    const r = await multipart(p, stu.token);
    assert.equal(r.status, 403, `student upload to ${p} must be 403 (got ${r.status})`);
  }
  assert.equal(uploadCount(), filesBefore, 'a rejected upload must not write a file to disk');

  assert.equal((await api('/data/assets', { token: stu.token })).status, 403, 'student cannot list assets');
  assert.equal((await api(`/data/process/${courseId}`, { method: 'POST', token: stu.token, body: {} })).status, 403, 'student cannot trigger indexing');
  assert.equal((await api(`/courses/${courseId}/ai/materials`, { method: 'POST', token: stu.token, body: {} })).status, 403);
  assert.equal((await api(`/nlp/index/push/${courseId}`, { method: 'POST', token: stu.token, body: {} })).status, 403);
  assert.equal((await db().query('SELECT 1 FROM document_chunks WHERE course_id = $1', [courseId])).rows.length, 0, 'nothing was indexed');

  // admin path still works end to end
  const up = await multipart(`/data/upload/${courseId}`, admin.token, 'admin-notes.txt', 'Photosynthesis converts light into chemical energy.');
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal((await api('/data/assets', { token: admin.token })).status, 200);
  const idx = await api(`/data/process/${courseId}`, { method: 'POST', token: admin.token, body: {} });
  assert.equal(idx.status, 200, JSON.stringify(idx.body));
  assert.ok(idx.body.processed_files >= 1);
});

test('F-20: chat rejects empty, non-string and oversized messages', async () => {
  const admin = await makeUser('admin');
  const { courseId } = await courseWithQuiz(admin);
  const stu = await makeUser('student');
  const sessionsBefore = Number((await db().query('SELECT count(*) FROM chat_sessions WHERE user_id = $1', [stu.id])).rows[0].count);

  for (const [label, body] of [['missing', {}], ['empty', { message: '' }], ['whitespace', { message: '   \n ' }], ['number', { message: 42 }], ['object', { message: { a: 1 } }], ['too long', { message: 'A'.repeat(4001) }], ['900KB', { message: 'A'.repeat(900000) }]]) {
    const r = await api(`/courses/${courseId}/ai/chat`, { method: 'POST', token: stu.token, body });
    assert.equal(r.status, 400, `${label} message must be 400 (got ${r.status})`);
  }
  const sessionsAfter = Number((await db().query('SELECT count(*) FROM chat_sessions WHERE user_id = $1', [stu.id])).rows[0].count);
  assert.equal(sessionsAfter, sessionsBefore, 'rejected messages must not create sessions');

  const edge = await api(`/courses/${courseId}/ai/chat`, { method: 'POST', token: stu.token, body: { message: 'A'.repeat(4000) } });
  assert.equal(edge.status, 200, 'a message at the limit is accepted');
});

test('F-06: AI quizzes are graded once, owner-only; the first grade is the authoritative score', async () => {
  const owner = await makeUser('student');
  const other = await makeUser('student');
  const quizId = `aiq-test-${Math.random().toString(36).slice(2, 10)}`;
  await db().query(
    `INSERT INTO ai_quiz_keys (quiz_id, topic, questions, user_id) VALUES ($1, 'topic', $2, $3)`,
    [quizId, JSON.stringify([{ id: 'q1', correctIndex: 1, explanation: 'e1' }, { id: 'q2', correctIndex: 0, explanation: 'e2' }]), owner.id]
  );

  // someone else's quiz is invisible
  assert.equal((await api(`/ai/quizzes/${quizId}/grade`, { method: 'POST', token: other.token, body: { answers: { q1: 1, q2: 0 } } })).status, 404);

  // first submission (both wrong) is final
  const first = await api(`/ai/quizzes/${quizId}/grade`, { method: 'POST', token: owner.token, body: { answers: { q1: 0, q2: 1 } } });
  assert.equal(first.status, 200);
  assert.equal(first.body.correct, 0);

  // learning the key from the response and re-submitting perfect answers must NOT change the score
  const second = await api(`/ai/quizzes/${quizId}/grade`, { method: 'POST', token: owner.token, body: { answers: { q1: 1, q2: 0 } } });
  assert.equal(second.status, 200);
  assert.equal(second.body.correct, 0, 'F-06: regrading must replay the first, authoritative result');

  // the results endpoint records the server score (0/2), whatever the client says
  const rec = await api('/agent/quizzes/results', { method: 'POST', token: owner.token, body: { task_id: 'task-A', quiz_id: quizId, score: 2, total: 2 } });
  assert.equal(rec.status, 200, JSON.stringify(rec.body));
  assert.equal(Number(rec.body.result.score), 0);
  assert.equal(Number(rec.body.result.total), 2);
});
