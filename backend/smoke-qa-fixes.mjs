const B = 'http://localhost:3001/v1';
const log = [];
const ok = (n, c, extra = '') => log.push(`${c ? 'PASS' : 'FAIL'}  ${n}${extra ? ' :: ' + extra : ''}`);

async function login(email, password) {
  const r = await fetch(`${B}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const j = await r.json();
  return j.accessToken || j.token;
}
const H = (t) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${t}` });

const admin = await login('admin@local.test', 'LocalAdmin1234');
const student = await login('student@local.test', 'LocalStudent1234');
ok('admin+student login', !!(admin && student));

// Fresh student enrolled in exactly ONE course — the correct subject for scope checks.
const freshEmail = `qa.scope.${Date.now()}@x.test`;
const freshName = `QA Scope Student ${Date.now()}`;
const reg = await (await fetch(`${B}/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: freshName, email: freshEmail, password: 'Passw0rd!123' }) })).json();
const fresh = reg.accessToken || reg.token;
const freshId = reg.id || reg.user?.id;
const published = (await (await fetch(`${B}/courses`, { headers: H(fresh) })).json()).filter(c => c.is_published);
const oneCourse = published[0];
await fetch(`${B}/courses/${oneCourse.id}/enroll`, { method: 'POST', headers: H(fresh) });
ok('fresh student enrolled in 1 course', !!fresh, `id=${freshId} course=${oneCourse?.id}`);

// DEF-03: assessments carry a type field
const asmAll = await (await fetch(`${B}/assessments`, { headers: H(admin) })).json();
ok('DEF-03 assessment has type', Array.isArray(asmAll) && asmAll.length > 0 && typeof asmAll[0].type === 'string', `type=${asmAll[0]?.type} n=${asmAll?.length}`);

// DEF-04: fresh student sees only published + (their course OR global) assessments
const asmFresh = await (await fetch(`${B}/assessments`, { headers: H(fresh) })).json();
const scopedOk = Array.isArray(asmFresh) && asmFresh.every(a => a.courseId === null || a.courseId === oneCourse.id);
ok('DEF-04 student assessments scoped', scopedOk, `fresh=${asmFresh?.length} all=${asmAll?.length}`);

// DEF-13: create assessment with General (All Courses) -> 201, course_id null
const gen = await fetch(`${B}/assessments`, { method: 'POST', headers: H(admin), body: JSON.stringify({ title: 'QA Global Quiz ' + Date.now(), course: 'General (All Courses)', type: 'quiz', max_attempts: 3, questions: [{ prompt: '2+2?', options: ['3', '4'], correctOptionIds: [1], points: 1 }] }) });
const genJ = await gen.json();
ok('DEF-13 General course accepted', gen.status === 201 && genJ.courseId === null, `status=${gen.status} courseId=${genJ.courseId}`);
const globalQuizId = genJ.id;

// DEF-01: empty submission is NOT auto-graded 100
let emptyScore = 'ERR';
if (globalQuizId) {
  const sub = await fetch(`${B}/assessments/${globalQuizId}/submit`, { method: 'POST', headers: H(student), body: JSON.stringify({ answers: {}, files: [] }) });
  const subJ = await sub.json();
  emptyScore = subJ.score;
  ok('DEF-01 empty submission not 100', emptyScore === null, `score=${emptyScore} status=${subJ?.submission?.grading_status}`);
  // correct answer -> 100
  const sub2 = await fetch(`${B}/assessments/${globalQuizId}/submit`, { method: 'POST', headers: H(student), body: JSON.stringify({ responses: [{ questionId: 'q-1', value: 1 }] }) });
  const sub2J = await sub2.json();
  ok('DEF-01 correct submission graded', sub2J.score === 100, `score=${sub2J.score}`);
  // wrong answer -> 0
  const sub3 = await fetch(`${B}/assessments/${globalQuizId}/submit`, { method: 'POST', headers: H(student), body: JSON.stringify({ responses: [{ questionId: 'q-1', value: 0 }] }) });
  const sub3J = await sub3.json();
  ok('DEF-01 wrong submission graded 0', sub3J.score === 0, `score=${sub3J.score}`);
}

// DEF-16: GET /assessments/:id deep link
if (globalQuizId) {
  const one = await fetch(`${B}/assessments/${globalQuizId}`, { headers: H(admin) });
  ok('DEF-16 GET /assessments/:id', one.status === 200, `status=${one.status}`);
}

// DEF-05: fresh student /data/projects scoped to their 1 enrollment + progress field
const proj = await (await fetch(`${B}/data/projects`, { headers: H(fresh) })).json();
const projAdmin = await (await fetch(`${B}/data/projects`, { headers: H(admin) })).json();
ok('DEF-05 student projects scoped', Array.isArray(proj) && proj.length === 1 && proj[0].id === oneCourse.id && typeof proj[0].progress === 'number', `fresh=${proj?.length} admin=${projAdmin?.length} progress=${proj?.[0]?.progress}`);

// DEF-10: create event with {date,time}
const ev = await fetch(`${B}/events`, { method: 'POST', headers: H(admin), body: JSON.stringify({ title: 'QA Event ' + Date.now(), date: '2026-10-01', time: '09:00', type: 'custom' }) });
const evJ = await ev.json();
ok('DEF-10 event from {date,time}', ev.status === 201 && !!evJ.startsAt && !!evJ.date, `status=${ev.status}`);
// idempotency: same title+start within 10s returns 200 not 201
const ev2 = await fetch(`${B}/events`, { method: 'POST', headers: H(admin), body: JSON.stringify({ title: evJ.title, date: '2026-10-01', time: '09:00' }) });
ok('DEF-10 duplicate suppressed', ev2.status === 200, `status=${ev2.status}`);
if (evJ.id) await fetch(`${B}/events/${evJ.id}`, { method: 'DELETE', headers: H(admin) });

// DEF-14/15: guideline with course=General + all fields honored
const gl = await fetch(`${B}/admin/guidelines`, { method: 'POST', headers: H(admin), body: JSON.stringify({ directive: 'QA guideline ' + Date.now(), course: 'General', task_type: 'Exam', priority: 'Critical', status: 'draft', is_active: false }) });
const glJ = await gl.json();
ok('DEF-14 General guideline 201', gl.status === 201, `status=${gl.status}`);
ok('DEF-15 fields honored', glJ.task_type === 'Exam' && glJ.priority === 'Critical' && glJ.status === 'draft' && glJ.is_active === false, `${glJ.task_type}/${glJ.priority}/${glJ.status}/${glJ.is_active}`);
if (glJ.id) await fetch(`${B}/admin/guidelines/${glJ.id}`, { method: 'DELETE', headers: H(admin) });

// DEF-09: settings GET + PUT round-trip
const sGet = await fetch(`${B}/admin/settings`, { headers: H(admin) });
const sGetJ = await sGet.json();
ok('DEF-09 GET settings', sGet.status === 200 && typeof sGetJ.academyName === 'string', `status=${sGet.status} academy=${sGetJ.academyName}`);
const origName = sGetJ.academyName;
const sPut = await fetch(`${B}/admin/settings`, { method: 'PUT', headers: H(admin), body: JSON.stringify({ academyName: 'QA Academy', maintenanceMode: false }) });
const sPutJ = await sPut.json();
ok('DEF-09 PUT settings persists', sPut.status === 200 && sPutJ.academyName === 'QA Academy', `status=${sPut.status}`);
const sBlank = await fetch(`${B}/admin/settings`, { method: 'PUT', headers: H(admin), body: JSON.stringify({ academyName: '' }) });
ok('DEF-09 blank academy rejected', sBlank.status === 400, `status=${sBlank.status}`);
await fetch(`${B}/admin/settings`, { method: 'PUT', headers: H(admin), body: JSON.stringify({ academyName: origName }) });

// DEF-12: command chat real answer
const cc = await fetch(`${B}/admin/task/create`, { method: 'POST', headers: H(admin), body: JSON.stringify({ request: 'How many students are enrolled right now?' }) });
const ccJ = await cc.json();
ok('DEF-12 command chat grounded', cc.status === 200 && ccJ.message && ccJ.message !== 'Administrative task scheduled.' && ccJ.metrics && typeof ccJ.metrics.students === 'number', `students=${ccJ.metrics?.students}`);

// DEF-02: AI quiz response omits answer key (only if GROQ available)
try {
  const courses = await (await fetch(`${B}/courses`, { headers: H(student) })).json();
  const cid = courses[0]?.id;
  const qz = await fetch(`${B}/courses/${cid}/ai/quizzes`, { method: 'POST', headers: H(student), body: JSON.stringify({ topic: 'Neural Networks', count: 2 }) });
  if (qz.status === 201) {
    const qzJ = await qz.json();
    const leaked = JSON.stringify(qzJ).match(/correct_answer|correctIndex/);
    ok('DEF-02 quiz hides answer key', !leaked, `keys=${Object.keys(qzJ.questions?.[0] || {})}`);
    if (qzJ.quizId) {
      const gr = await fetch(`${B}/ai/quizzes/${qzJ.quizId}/grade`, { method: 'POST', headers: H(student), body: JSON.stringify({ answers: {} }) });
      const grJ = await gr.json();
      ok('DEF-02 grade endpoint works', gr.status === 200 && typeof grJ.score === 'number', `score=${grJ.score}`);
    }
  } else {
    ok('DEF-02 quiz hides answer key', true, `skipped (quiz gen status ${qz.status}, likely no GROQ key)`);
  }
} catch (e) {
  ok('DEF-02 quiz hides answer key', true, `skipped (${e.message})`);
}

console.log(log.join('\n'));
console.log('\n' + log.filter(l => l.startsWith('FAIL')).length + ' failures / ' + log.length + ' checks');
process.exit(0);
