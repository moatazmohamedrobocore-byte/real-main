import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, resetDb, makeUser, api } from './helpers.mjs';

before(async () => { await resetDb(); await startServer(); });
after(async () => { await stopServer(); });

async function makeCourse(admin, { status = 'published', lessons = 0 } = {}) {
  const c = await api('/courses', { method: 'POST', token: admin.token, body: { title: `C-${Math.random().toString(36).slice(2)}`, description: 'desc', status } });
  const courseId = c.body.id;
  const ids = [];
  for (let i = 0; i < lessons; i++) {
    const l = await api(`/courses/${courseId}/lessons`, { method: 'POST', token: admin.token, body: { title: `Lesson ${i + 1}`, content: `SECRET_BODY_${i + 1}`, status: 'published' } });
    ids.push(l.body.id || l.body.lesson?.id);
  }
  return { courseId, lessonIds: ids };
}

test('F-02: public catalog excludes drafts; admin sees them', async () => {
  const admin = await makeUser('admin');
  const { courseId: pubId } = await makeCourse(admin, { status: 'published', lessons: 1 });
  const { courseId: draftId } = await makeCourse(admin, { status: 'draft', lessons: 1 });

  const anon = await api('/courses');
  const anonIds = anon.body.map((c) => c.id);
  assert.ok(anonIds.includes(pubId), 'anonymous sees published course');
  assert.ok(!anonIds.includes(draftId), 'F-02: anonymous must NOT see draft course');

  const asAdmin = await api('/courses', { token: admin.token });
  const adminIds = asAdmin.body.map((c) => c.id);
  assert.ok(adminIds.includes(draftId), 'admin sees draft course');

  // lesson bodies stripped for anonymous
  const pubCourse = anon.body.find((c) => c.id === pubId);
  const leaked = JSON.stringify(pubCourse.lessons || []);
  assert.ok(!leaked.includes('SECRET_BODY'), 'F-02: catalog must not include lesson content for public');
});

test('F-02: lesson detail gates unpublished, non-preview, and unenrolled access', async () => {
  const admin = await makeUser('admin');
  const { courseId, lessonIds } = await makeCourse(admin, { status: 'published', lessons: 2 });
  const [first, second] = lessonIds;

  const stranger = await makeUser('student');
  const preview = await api(`/courses/${courseId}/lessons/${first}`, { token: stranger.token });
  assert.equal(preview.status, 200, 'first lesson is a free preview');
  const locked = await api(`/courses/${courseId}/lessons/${second}`, { token: stranger.token });
  assert.equal(locked.status, 403, 'F-02: non-preview lesson requires enrollment');

  const enrolled = await makeUser('student');
  await api(`/courses/${courseId}/enroll/${enrolled.id}`, { method: 'POST', token: admin.token });
  const ok = await api(`/courses/${courseId}/lessons/${second}`, { token: enrolled.token });
  assert.equal(ok.status, 200, 'enrolled student can read the lesson');
  assert.ok(String(ok.body.content || '').includes('SECRET_BODY_2'), 'enrolled student gets content');

  // draft course lesson is invisible to non-staff
  const draftCtx = await makeCourse(admin, { status: 'draft', lessons: 1 });
  const draftLesson = await api(`/courses/${draftCtx.courseId}/lessons/${draftCtx.lessonIds[0]}`, { token: stranger.token });
  assert.equal(draftLesson.status, 404, 'F-02: draft-course lesson is 404 for non-staff');
});

test('F-04: cannot start an unpublished assessment; unenrolled blocked; enrolled allowed', async () => {
  const admin = await makeUser('admin');
  const { courseId } = await makeCourse(admin, { status: 'published' });

  const draftAsm = await api(`/courses/${courseId}/assessments`, {
    method: 'POST', token: admin.token,
    body: { title: 'Draft Quiz', type: 'quiz', status: 'draft', max_attempts: 1, time_limit_seconds: 600, questions: [{ prompt: 'q', options: ['a', 'b'], correctOptionIds: [0], points: 1 }] }
  });
  const enrolled = await makeUser('student');
  await api(`/courses/${courseId}/enroll/${enrolled.id}`, { method: 'POST', token: admin.token });

  const startDraft = await api(`/assessments/${draftAsm.body.id}/start`, { method: 'POST', token: enrolled.token });
  assert.equal(startDraft.status, 404, 'F-04: draft assessment is not startable by students');

  // publish it
  await api(`/assessments/${draftAsm.body.id}/publish`, { method: 'POST', token: admin.token });
  const outsider = await makeUser('student');
  const startUnenrolled = await api(`/assessments/${draftAsm.body.id}/start`, { method: 'POST', token: outsider.token });
  assert.equal(startUnenrolled.status, 403, 'F-04: unenrolled student cannot start');

  const startOk = await api(`/assessments/${draftAsm.body.id}/start`, { method: 'POST', token: enrolled.token });
  assert.equal(startOk.status, 201, `F-04: enrolled student can start published assessment, got ${startOk.status} ${JSON.stringify(startOk.body)}`);
});
