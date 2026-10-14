import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { startServer, stopServer, resetDb, makeUser, api, login, db, BASE, TEST_PORT, TEST_JWT_ACCESS } from './helpers.mjs';

before(async () => { await resetDb(); await startServer(); });
after(async () => { await stopServer(); });

const uniq = () => Math.random().toString(36).slice(2, 8);
const MCQ = (id = 'q1') => ({ id, type: 'mcq', prompt: '2+2?', options: ['3', '4'], correctOptionIds: [1], points: 1 });

async function newCourse(admin, extra = {}) {
  const r = await api('/courses', { method: 'POST', token: admin.token, body: { title: `Course ${uniq()}`, description: 'd', status: 'published', ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.id;
}
async function newAssessment(admin, courseId, body) {
  const r = await api(`/courses/${courseId}/assessments`, { method: 'POST', token: admin.token, body: { title: `A ${uniq()}`, type: 'quiz', status: 'published', ...body } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.id;
}
async function enrolledStudent(admin, courseId) {
  const s = await makeUser('student');
  await api(`/courses/${courseId}/enroll/${s.id}`, { method: 'POST', token: admin.token });
  return s;
}
const expireAttempt = (id) => db().query("UPDATE submissions SET expires_at = now() - interval '2 minutes' WHERE id = $1", [id]);
const attemptRow = async (id) => (await db().query('SELECT attempt_status, grading_status, grading_score FROM submissions WHERE id = $1', [id])).rows[0];

// ---------------------------------------------------------------- F-08 / F-19
test('F-08: a Jitsi join token is not a valid API token; only type=access tokens authenticate', async () => {
  const admin = await makeUser('admin');
  const courseId = await newCourse(admin);
  const stu = await enrolledStudent(admin, courseId);
  const m = await api('/meetings', { method: 'POST', token: admin.token, body: { title: 'Live', courseId } });
  const meetingId = m.body.id || m.body.meeting?.id;
  await api(`/meetings/${meetingId}/launch`, { method: 'POST', token: admin.token, body: {} });

  const join = await api(`/live-sessions/${meetingId}/join-token`, { method: 'POST', token: stu.token });
  assert.equal(join.status, 200, JSON.stringify(join.body));
  const joinToken = join.body.token;
  assert.ok(joinToken, 'join token issued');
  assert.throws(() => jwt.verify(joinToken, TEST_JWT_ACCESS), 'join token must NOT verify under the API access secret');
  assert.equal((await api('/auth/me', { token: joinToken })).status, 401, 'F-08: join token rejected by the API');

  // a correctly signed token that is not an access token is rejected too (F-19)
  const base = { sub: stu.id };
  assert.equal((await api('/auth/me', { token: jwt.sign(base, TEST_JWT_ACCESS, { expiresIn: '5m' }) })).status, 401, 'untyped token rejected');
  assert.equal((await api('/auth/me', { token: jwt.sign({ ...base, type: 'refresh' }, TEST_JWT_ACCESS, { expiresIn: '5m' }) })).status, 401, 'refresh-typed token rejected');
  assert.equal((await api('/auth/me', { token: jwt.sign({ ...base, type: 'access' }, TEST_JWT_ACCESS, { expiresIn: '5m' }) })).status, 200, 'a genuine access token still works');
  assert.equal((await api('/auth/me', { token: stu.token })).status, 200, 'normal login token still works');
});

// ---------------------------------------------------------------- F-09
test('F-09: an overdue attempt is finalized from SAVED answers; late answers are discarded', async () => {
  const admin = await makeUser('admin');
  const courseId = await newCourse(admin);
  const asm = await newAssessment(admin, courseId, { timeLimitSeconds: 600, questions: [MCQ('q1')] });
  const stu = await enrolledStudent(admin, courseId);

  const start = await api(`/assessments/${asm}/start`, { method: 'POST', token: stu.token });
  assert.equal(start.status, 201);
  const sid = start.body.id;
  assert.equal((await api(`/attempts/${sid}/answers`, { method: 'PUT', token: stu.token, body: { responses: [{ questionId: 'q1', value: 1 }] } })).status, 200);

  await expireAttempt(sid);
  // the student now sends a DIFFERENT (wrong) answer after the deadline
  const late = await api(`/attempts/${sid}/submit`, { method: 'POST', token: stu.token, body: { responses: [{ questionId: 'q1', value: 0 }] } });
  assert.equal(late.status, 409, `late submit must be refused: ${JSON.stringify(late.body)}`);
  assert.equal(late.body.error.code, 'ATTEMPT_EXPIRED');
  const row = await attemptRow(sid);
  assert.equal(row.attempt_status, 'timed_out');
  assert.equal(Number(row.grading_score), 100, 'scored from the answers saved BEFORE the deadline, not the late ones');
  assert.ok(!JSON.stringify(late.body).includes('correctOptionIds'));
});

test('F-09: saving answers and starting again after the deadline is refused and closes the attempt', async () => {
  const admin = await makeUser('admin');
  const courseId = await newCourse(admin);
  const asm = await newAssessment(admin, courseId, { questions: [MCQ('q1')] });

  const a = await enrolledStudent(admin, courseId);
  const sa = (await api(`/assessments/${asm}/start`, { method: 'POST', token: a.token })).body.id;
  await expireAttempt(sa);
  const put = await api(`/attempts/${sa}/answers`, { method: 'PUT', token: a.token, body: { responses: [{ questionId: 'q1', value: 1 }] } });
  assert.equal(put.status, 409, 'autosave after the deadline refused');
  assert.equal((await attemptRow(sa)).attempt_status, 'timed_out');

  const b = await enrolledStudent(admin, courseId);
  const sb = (await api(`/assessments/${asm}/start`, { method: 'POST', token: b.token })).body.id;
  await expireAttempt(sb);
  const again = await api(`/assessments/${asm}/start`, { method: 'POST', token: b.token });
  assert.equal(again.status, 409, 're-start of an overdue attempt refused');
  assert.equal((await attemptRow(sb)).attempt_status, 'timed_out', 'overdue attempt is closed, not left in_progress forever');
});

test('F-09: the shipped exam page (direct submit, no submission id) still honours a started attempt and the due date', async () => {
  const admin = await makeUser('admin');
  const courseId = await newCourse(admin);
  const asm = await newAssessment(admin, courseId, { questions: [MCQ('q1')] });
  const stu = await enrolledStudent(admin, courseId);
  const sid = (await api(`/assessments/${asm}/start`, { method: 'POST', token: stu.token })).body.id;
  await expireAttempt(sid);
  const direct = await api(`/assessments/${asm}/submit`, { method: 'POST', token: stu.token, body: { answers: [{ questionId: 'q1', value: 1 }] } });
  assert.equal(direct.status, 409, 'direct submit completes the started attempt, so its deadline applies');
  assert.equal(direct.body.error.code, 'ATTEMPT_EXPIRED');

  // due date: quizzes cannot be handed in after it, even without a server-side start
  const overdue = await newAssessment(admin, courseId, { questions: [MCQ('q1')], dueAt: new Date(Date.now() - 3600e3).toISOString() });
  const s2 = await enrolledStudent(admin, courseId);
  const late = await api(`/assessments/${overdue}/submit`, { method: 'POST', token: s2.token, body: { answers: [{ questionId: 'q1', value: 1 }] } });
  assert.equal(late.status, 409);
  assert.equal(late.body.error.code, 'ASSESSMENT_PAST_DUE');

  // and a normal in-time direct submit still works
  const fine = await newAssessment(admin, courseId, { questions: [MCQ('q1')] });
  const s3 = await enrolledStudent(admin, courseId);
  const ok = await api(`/assessments/${fine}/submit`, { method: 'POST', token: s3.token, body: { answers: [{ questionId: 'q1', value: 1 }] } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.score, 100);
});

// ---------------------------------------------------------------- F-10
test('F-10: open-ended questions go to manual review; they are never auto-scored 0', async () => {
  const admin = await makeUser('admin');
  const courseId = await newCourse(admin);
  const cases = [
    ['essay only', [{ id: 'e1', type: 'essay', prompt: 'Explain TCP', points: 10 }], [{ questionId: 'e1', value: 'TCP is reliable.' }]],
    ['mcq + essay', [MCQ('q1'), { id: 'e1', type: 'essay', prompt: 'Why?', points: 5 }], [{ questionId: 'q1', value: 1 }, { questionId: 'e1', value: 'because' }]],
    ['mcq without a key', [{ id: 'q1', type: 'mcq', prompt: 'Pick', options: ['a', 'b'], points: 1 }], [{ questionId: 'q1', value: 0 }]]
  ];
  for (const [label, questions, answers] of cases) {
    const asm = await newAssessment(admin, courseId, { type: 'exam', questions });
    const stu = await enrolledStudent(admin, courseId);
    const r = await api(`/assessments/${asm}/submit`, { method: 'POST', token: stu.token, body: { answers } });
    assert.equal(r.status, 200, `${label}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.submission.grading_status, 'manual_review', `${label}: must await manual grading`);
    assert.equal(r.body.score, null, `${label}: no score until a human grades it`);
  }
  // fully machine-gradable work is still auto-graded
  const asm = await newAssessment(admin, courseId, { questions: [MCQ('q1')] });
  const stu = await enrolledStudent(admin, courseId);
  const r = await api(`/assessments/${asm}/submit`, { method: 'POST', token: stu.token, body: { answers: [{ questionId: 'q1', value: 1 }] } });
  assert.equal(r.body.submission.grading_status, 'auto_graded');
  assert.equal(r.body.score, 100);
});

test('F-10: a multi-correct question needs ALL correct options and no wrong ones', async () => {
  const admin = await makeUser('admin');
  const courseId = await newCourse(admin);
  const asm = await newAssessment(admin, courseId, { questions: [{ id: 'm1', type: 'mcq', prompt: 'Primes', options: ['2', '3', '4'], correctOptionIds: [0, 1], points: 1 }] });
  const score = async (value) => {
    const stu = await enrolledStudent(admin, courseId);
    // each student has one attempt, so use a fresh assessment per answer shape
    const own = await newAssessment(admin, courseId, { questions: [{ id: 'm1', type: 'mcq', prompt: 'Primes', options: ['2', '3', '4'], correctOptionIds: [0, 1], points: 1 }] });
    const r = await api(`/assessments/${own}/submit`, { method: 'POST', token: stu.token, body: { answers: [{ questionId: 'm1', value }] } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.score;
  };
  assert.equal(await score(0), 0, 'one of two correct options is not full credit');
  assert.equal(await score([0, 1]), 100, 'both correct options earns full credit');
  assert.equal(await score([1, 0]), 100, 'order does not matter');
  assert.equal(await score([0, 1, 2]), 0, 'an extra wrong option cancels the credit');
  assert.ok(asm);
});

// ---------------------------------------------------------------- F-11
test('F-11: logout revokes that login session, and only that one', async () => {
  const u = await makeUser('student');
  const s1 = await login(u.email, u.password);
  const s2 = await login(u.email, u.password);
  const rt1 = s1.body.refreshToken, rt2 = s2.body.refreshToken;
  assert.ok(rt1 && rt2);

  assert.equal((await api('/auth/logout', { method: 'POST', token: s1.token, body: {} })).status, 204);
  assert.equal((await api('/auth/refresh', { method: 'POST', body: { refreshToken: rt1 } })).status, 401, 'F-11: refresh token of the logged-out session is dead');
  assert.equal((await api('/auth/refresh', { method: 'POST', body: { refreshToken: rt2 } })).status, 200, 'the user\'s other session is unaffected');

  // rotated tokens inherit the session family, so logging out after a refresh still revokes it
  const s3 = await login(u.email, u.password);
  const rotated = await api('/auth/refresh', { method: 'POST', body: { refreshToken: s3.body.refreshToken } });
  assert.equal(rotated.status, 200);
  assert.equal((await api('/auth/logout', { method: 'POST', token: rotated.body.accessToken, body: {} })).status, 204);
  assert.equal((await api('/auth/refresh', { method: 'POST', body: { refreshToken: rotated.body.refreshToken } })).status, 401, 'rotated session is revoked on logout');

  // an access token is not accepted as a refresh token
  assert.equal((await api('/auth/refresh', { method: 'POST', body: { refreshToken: s2.token } })).status, 401);
});

// ---------------------------------------------------------------- F-14
test('F-14: attachments never inherit the uploader\'s Content-Type; risky types are forced downloads', async () => {
  const admin = await makeUser('admin');
  const courseId = await newCourse(admin);
  const asm = await newAssessment(admin, courseId, { type: 'assignment', questions: [] });
  const stu = await enrolledStudent(admin, courseId);

  const fd = new FormData();
  fd.append('files', new Blob(['<script>alert(1)</script>'], { type: 'text/html' }), 'report.txt');
  fd.append('files', new Blob(['<script>alert(1)</script>'], { type: 'text/html' }), 'tool.py');
  fd.append('files', new Blob(['<script>alert(1)</script>'], { type: 'text/html' }), 'archive.zip');
  const up = await fetch(`${BASE}/assessments/${asm}/submit`, { method: 'POST', headers: { Authorization: `Bearer ${stu.token}` }, body: fd });
  const upBody = await up.json();
  assert.equal(up.status, 200, JSON.stringify(upBody));
  const sid = upBody.submission.id;

  const list = await api(`/attempts/${sid}/files`, { token: admin.token });
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 3);
  for (const f of list.body) {
    const res = await fetch(`http://localhost:${TEST_PORT}${f.downloadUrl}`, { headers: { Authorization: `Bearer ${admin.token}` } });
    const ct = res.headers.get('content-type') || '';
    const cd = res.headers.get('content-disposition') || '';
    assert.ok(!/html/i.test(ct), `${f.original_name}: Content-Type must never be html (got ${ct})`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    if (f.original_name === 'report.txt') {
      assert.match(ct, /^text\/plain/);
      assert.match(cd, /^inline/);
    } else {
      assert.equal(ct, 'application/octet-stream', `${f.original_name} is served as a generic download`);
      assert.match(cd, /^attachment/);
    }
  }
});

// ---------------------------------------------------------------- F-15
test('F-15: paid courses cannot be self-enrolled; free ones can; admins can enroll anyone', async () => {
  const admin = await makeUser('admin');
  const paid = await newCourse(admin, { pricing: { access: 'paid', currency: 'USD', amount: 49 } });
  const free = await newCourse(admin);
  const stu = await makeUser('student');

  const denied = await api(`/courses/${paid}/enroll`, { method: 'POST', token: stu.token });
  assert.equal(denied.status, 402, JSON.stringify(denied.body));
  assert.equal(denied.body.error.code, 'PAYMENT_REQUIRED');
  assert.equal((await db().query('SELECT 1 FROM enrollments WHERE student_id = $1 AND course_id = $2', [stu.id, paid])).rows.length, 0, 'no enrollment row was created');

  assert.equal((await api(`/courses/${free}/enroll`, { method: 'POST', token: stu.token })).status, 201, 'free course still self-enrolls');
  assert.equal((await api(`/courses/${paid}/enroll/${stu.id}`, { method: 'POST', token: admin.token })).status, 201, 'admin enrollment into a paid course still works');
});

// ---------------------------------------------------------------- F-12 (last: it exhausts rate-limit buckets)
test('F-12: the login limiter key is normalised, tolerates odd input, and is also capped per IP', async () => {
  const victim = await makeUser('student');
  const attempt = (email) => fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'definitely-wrong-1' }) });

  // padding / casing variants of ONE account must share a single bucket (max 20 / 15 min)
  const statuses = [];
  for (let i = 0; i < 30; i++) {
    const variant = i % 2 ? ' '.repeat(i) + victim.email.toUpperCase() : victim.email + ' '.repeat(i);
    statuses.push((await attempt(variant)).status);
  }
  assert.ok(statuses.includes(429), `padded/cased variants must be throttled together: ${[...new Set(statuses)]}`);
  assert.ok(statuses.indexOf(429) <= 20, `throttling must start by the 21st attempt (started at ${statuses.indexOf(429) + 1})`);

  // non-string emails must be a clean 400, not a crashed limiter
  for (const bad of [12345, { a: 1 }, ['x@y.co'], null]) {
    const r = await attempt(bad);
    assert.equal(r.status, 400, `email=${JSON.stringify(bad)} must be 400 (got ${r.status})`);
  }

  // password spraying across many accounts from one IP hits the per-IP ceiling (100 failures)
  let tripped = false;
  for (let i = 0; i < 110 && !tripped; i++) tripped = (await attempt(`spray${i}.${uniq()}@test.local`)).status === 429;
  assert.ok(tripped, 'F-12: one IP cannot spray unlimited accounts');
});
