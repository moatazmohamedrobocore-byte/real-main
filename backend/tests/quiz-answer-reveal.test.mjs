import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, resetDb, makeUser, api, db, TEST_PORT } from './helpers.mjs';

before(async () => { await resetDb(); await startServer(); });
after(async () => { await stopServer(); });

async function seedQuiz(owner) {
  const quizId = `aiq-test-${Math.random().toString(36).slice(2, 10)}`;
  await db().query(
    `INSERT INTO ai_quiz_keys (quiz_id, topic, questions, user_id) VALUES ($1, 'topic', $2, $3)`,
    [quizId, JSON.stringify([
      { id: 'q1', correctIndex: 1, explanation: 'Because B is right.' },
      { id: 'q2', correctIndex: 0, explanation: 'Because A is right.' }
    ]), owner.id]
  );
  return quizId;
}
const answer = (token, quizId, body) => api(`/ai/quizzes/${quizId}/answer`, { method: 'POST', token, body });

test('quiz answer reveal: right/wrong, correct option and explanation are returned after the choice', async () => {
  const stu = await makeUser('student');
  const quizId = await seedQuiz(stu);

  const wrong = await answer(stu.token, quizId, { questionId: 'q1', selected: 0 });
  assert.equal(wrong.status, 200, JSON.stringify(wrong.body));
  assert.equal(wrong.body.isCorrect, false);
  assert.equal(wrong.body.correctIndex, 1);
  assert.equal(wrong.body.correct_answer, '1', 'the quiz page keys options by their index as a string');
  assert.equal(wrong.body.explanation, 'Because B is right.');

  const right = await answer(stu.token, quizId, { questionId: 'q2', selected: 0 });
  assert.equal(right.body.isCorrect, true);
  assert.equal(right.body.explanation, 'Because A is right.');
});

test('quiz answer reveal: the first choice is locked; the final grade honours it', async () => {
  const stu = await makeUser('student');
  const quizId = await seedQuiz(stu);

  const first = await answer(stu.token, quizId, { questionId: 'q1', selected: 0 }); // wrong, now revealed
  assert.equal(first.body.isCorrect, false);
  // seeing the answer, the student "changes" to the correct option: the locked choice stays
  const again = await answer(stu.token, quizId, { questionId: 'q1', selected: 1 });
  assert.equal(again.body.selected, 0, 'a revealed question cannot be changed');
  assert.equal(again.body.isCorrect, false);

  await answer(stu.token, quizId, { questionId: 'q2', selected: 0 });
  // the client submits perfect answers at the end; q1 must still count as the locked wrong one
  const grade = await api(`/ai/quizzes/${quizId}/grade`, { method: 'POST', token: stu.token, body: { answers: { q1: 1, q2: 0 } } });
  assert.equal(grade.status, 200, JSON.stringify(grade.body));
  assert.equal(grade.body.correct, 1, 'only q2 is correct');
  assert.equal(grade.body.total, 2);

  // once graded, no further reveals
  assert.equal((await answer(stu.token, quizId, { questionId: 'q2', selected: 0 })).status, 404);
});

test('quiz answer reveal: owner-only, validated input, unknown question', async () => {
  const owner = await makeUser('student');
  const other = await makeUser('student');
  const quizId = await seedQuiz(owner);

  assert.equal((await answer(other.token, quizId, { questionId: 'q1', selected: 1 })).status, 404, "another user cannot probe someone else's quiz");
  assert.equal((await api(`/ai/quizzes/${quizId}/answer`, { method: 'POST', body: { questionId: 'q1', selected: 1 } })).status, 401);
  for (const bad of [{}, { questionId: 'q1' }, { questionId: 'q1', selected: 'x' }, { questionId: 'q1', selected: -1 }, { questionId: 'q1', selected: 99 }, { questionId: 5, selected: 0 }]) {
    assert.equal((await answer(owner.token, quizId, bad)).status, 400, `bad input ${JSON.stringify(bad)}`);
  }
  assert.equal((await answer(owner.token, quizId, { questionId: 'nope', selected: 0 })).status, 404);
  assert.equal((await answer(owner.token, 'aiq-does-not-exist', { questionId: 'q1', selected: 0 })).status, 404);
});

test('the in-place patched bundles are revalidated, other hashed assets stay immutable', async () => {
  const get = (p) => fetch(`http://localhost:${TEST_PORT}${p}`);
  const quiz = await get('/assets/StudentQuiz-D7rIh7I4.js');
  if (quiz.status === 404) return; // frontend build not served in this environment
  assert.equal(quiz.headers.get('cache-control'), 'no-cache');
  // F-18: the profile chunks were edited in place too, so they must revalidate as well.
  for (const name of ['StudentProfile-9TawEEYy.js', 'AdminProfile-YsL5zDb7.js']) {
    assert.equal((await get(`/assets/${name}`)).headers.get('cache-control'), 'no-cache', `${name} must not be immutable-cached`);
  }
  const other = await get('/assets/api-DvVeKkjb.js');
  assert.match(other.headers.get('cache-control') || '', /immutable/);
});

test('versioned frontend URLs bypass previously immutable-cached quiz modules', async () => {
  const get = (p) => fetch(`http://localhost:${TEST_PORT}${p}`);
  const page = await get('/student/quiz');
  const html = await page.text();
  assert.match(html, /src="\/assets\/quiz-reveal-v2\/index-BOtlBGmE\.js"/);
  assert.match(page.headers.get('cache-control'), /no-cache|max-age=0/);
  for (const name of ['index-BOtlBGmE.js', 'api-DvVeKkjb.js', 'vendor-react-CeZ512P1.js', 'StudentQuiz-D7rIh7I4.js', 'index-CjDZATa7.css']) {
    const original = await get(`/assets/${name}`);
    const versioned = await get(`/assets/quiz-reveal-v2/${name}`);
    assert.equal(versioned.status, 200, name);
    assert.equal(await versioned.text(), await original.text(), `${name} serves the same asset under the fresh URL`);
    if (name.startsWith('StudentQuiz-')) assert.equal(versioned.headers.get('cache-control'), 'no-cache');
  }
});
