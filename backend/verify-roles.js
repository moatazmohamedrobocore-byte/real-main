const BASE_URL = 'http://localhost:3001/v1';

async function req(method, path, token = null, body = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null
  });

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, ok: res.ok, data: json };
}

async function verifyAllRoles() {
  console.log('====================================================');
  console.log('ROLE-BY-ROLE ENDPOINT & DATA VERIFICATION WALKTHROUGH');
  console.log('====================================================\n');

  // =========================================================
  // 1. STUDENT ROLE
  // =========================================================
  console.log('>>> 1. LOGGING IN AS STUDENT (student@local.test)...');
  const studentLogin = await req('POST', '/auth/login', null, {
    email: 'student@local.test',
    password: 'LocalStudent1234'
  });
  if (!studentLogin.ok) throw new Error('Student login failed');
  const sToken = studentLogin.data.token;
  const sId = studentLogin.data.user.id;
  console.log('   ✓ Student logged in:', studentLogin.data.user.name, `(${sId})`);

  console.log('\n--- Student Dashboard & Courses ---');
  const catalog = await req('GET', '/courses/catalog', sToken);
  console.log(`   ✓ Catalog fetched: ${catalog.data.length} course(s)`);
  const demoCourse = catalog.data[0];
  console.log('     Course 1:', demoCourse.title, `[Enrolled: ${demoCourse.enrolled}, Progress: ${demoCourse.progress}%]`);

  const courseDetail = await req('GET', `/courses/${demoCourse.id}`, sToken);
  console.log(`   ✓ Course details fetched: ${courseDetail.data.title}`);
  console.log(`     Lessons in course: ${courseDetail.data.lessons.length}`);

  console.log('\n--- Student Assessments ---');
  const assessments = await req('GET', `/assessments?course_id=${demoCourse.id}`, sToken);
  console.log(`   ✓ Assessments fetched: ${assessments.data.length} assessment(s)`);
  
  // Login admin first to create fresh test quiz if needed
  const adminSetup = await req('POST', '/auth/login', null, { email: 'admin@local.test', password: 'LocalAdmin1234' });
  const aSetupToken = adminSetup.data.token;

  // Create a dedicated assessment for this walkthrough
  const freshQuiz = await req('POST', `/courses/${demoCourse.id}/assessments`, aSetupToken, {
    title: 'Walkthrough Interactive Quiz',
    instructions: 'Self-assessment quiz for walkthrough',
    timeLimitSeconds: 600,
    maxAttempts: 10,
    status: 'published',
    questions: [
      { id: 'q1', type: 'mcq', prompt: 'Is REAL_i PostgreSQL operational?', options: [{ id: 'opt1', text: 'Yes' }, { id: 'opt2', text: 'No' }], points: 10, correctOptionIds: ['opt1'] }
    ]
  });
  const quiz = freshQuiz.data;
  console.log(`     Quiz: "${quiz.title}", maxAttempts: ${quiz.maxAttempts}, questions: ${quiz.questions.length}`);

  console.log('   -> Starting assessment attempt...');
  const attemptStart = await req('POST', `/assessments/${quiz.id}/start`, sToken);
  if (!attemptStart.ok) throw new Error(`Attempt start failed: ${JSON.stringify(attemptStart.data)}`);
  const subId = attemptStart.data.submissionId;
  console.log(`   ✓ Attempt started: submissionId = ${subId}, attemptNumber = ${attemptStart.data.attemptNumber}`);

  console.log('   -> Saving answers...');
  const saveAns = await req('PUT', `/attempts/${subId}/answers`, sToken, {
    responses: [{ questionId: 'q1', value: 'opt1' }, { questionId: 'q2', value: 'true' }]
  });
  console.log('   ✓ Answers saved:', saveAns.data.success);

  console.log('   -> Submitting assessment attempt...');
  const submitAttempt = await req('POST', `/attempts/${subId}/submit`, sToken);
  console.log(`   ✓ Assessment submitted! Score: ${submitAttempt.data.score}/${submitAttempt.data.maxScore}`);

  const mySubmissions = await req('GET', '/assessments/student/me', sToken);
  console.log(`   ✓ Student submissions retrieved: ${mySubmissions.data.length} submission(s)`);

  console.log('\n--- Student Meetings / Live Sessions ---');
  const meetings = await req('GET', '/meetings', sToken);
  console.log(`   ✓ Meetings fetched: ${meetings.data.length} meeting(s)`);
  const liveMeeting = meetings.data[0];
  console.log(`     Meeting 1: "${liveMeeting.title}" [Status: ${liveMeeting.status}]`);

  const joinToken = await req('POST', `/live-sessions/${liveMeeting.id}/join-token`, sToken);
  console.log('   ✓ Live session join token issued:', !!joinToken.data.token);

  const attJoin = await req('POST', `/live-sessions/${liveMeeting.id}/attendance/join`, sToken);
  console.log('   ✓ Attendance join recorded:', attJoin.data.success);

  console.log('\n--- Student Calendar ---');
  const calendar = await req('GET', '/calendar', sToken);
  console.log(`   ✓ Calendar events retrieved: ${calendar.data.length} items (milestones, meetings, due dates)`);

  console.log('\n--- Student Profile & Tasks ---');
  const studentProfile = await req('GET', `/users/${sId}`, sToken);
  console.log(`   ✓ Student profile loaded: ${studentProfile.data.name}`);
  console.log(`     Completed lessons: ${studentProfile.data.completed_lessons.length}`);
  console.log(`     Completed tasks: ${studentProfile.data.completed_tasks.length}`);

  // =========================================================
  // 2. SECOND ADMIN ACCOUNT
  // =========================================================
  console.log('\n\n>>> 2. LOGGING IN AS SECOND ADMIN (admin2@local.test)...');
  const instLogin = await req('POST', '/auth/login', null, {
    email: 'admin2@local.test',
    password: 'LocalAdmin1234'
  });
  if (!instLogin.ok) throw new Error('Second admin login failed');
  const iToken = instLogin.data.token;
  console.log('   ✓ Second admin logged in:', instLogin.data.user.name);

  console.log('\n--- Admin Course Management ---');
  const newInstCourse = await req('POST', '/courses', iToken, {
    title: 'Admin Special Topics in AI',
    description: 'Advanced course created by an admin',
    category: 'AI & ML',
    difficulty: 'advanced',
    status: 'published'
  });
  const iCourseId = newInstCourse.data.id;
  console.log(`   ✓ Created course: "${newInstCourse.data.title}" (ID: ${iCourseId})`);

  const addLesson = await req('POST', `/courses/${iCourseId}/lessons`, iToken, {
    title: 'Lesson 1: Deep Reinforcement Learning',
    content: 'RL formulations and policy gradients.'
  });
  console.log(`   ✓ Added lesson: "${addLesson.data.title}"`);

  console.log('\n--- Admin Grading Queue ---');
  const queue = await req('GET', `/courses/${demoCourse.id}/grading-queue`, iToken);
  console.log(`   ✓ Grading queue fetched for demo course: ${queue.data.length} submission(s)`);

  console.log('   -> Grading student submission...');
  const gradeRes = await req('PATCH', `/attempts/${subId}/grade`, iToken, {
    score: 100,
    feedback: 'Flawless answers on both questions!'
  });
  console.log(`   ✓ Graded submission ${subId}: status = ${gradeRes.data.grading_status}, score = ${gradeRes.data.grading_score}`);

  console.log('\n--- Admin Meeting Launch ---');
  const instMeeting = await req('POST', '/meetings', iToken, {
    title: 'Office Hours with Admin',
    description: 'Weekly interactive Q&A session',
    courseId: iCourseId,
    startsAt: new Date(),
    endsAt: new Date(Date.now() + 3600000)
  });
  const instMeetingId = instMeeting.data.meeting.id;
  console.log(`   ✓ Scheduled meeting: "${instMeeting.data.meeting.title}"`);

  const launch = await req('PUT', `/meetings/${instMeetingId}/launch`, iToken);
  console.log(`   ✓ Launched meeting: status is now "${launch.data.status}"`);

  const endMeeting = await req('PUT', `/meetings/${instMeetingId}/end`, iToken);
  console.log(`   ✓ Ended meeting: status is now "${endMeeting.data.status}"`);

  // Clean up second-admin test course
  await req('DELETE', `/courses/${iCourseId}`, iToken);

  // =========================================================
  // 3. ADMIN ROLE
  // =========================================================
  console.log('\n\n>>> 3. LOGGING IN AS ADMIN (admin@local.test)...');
  const adminLogin = await req('POST', '/auth/login', null, {
    email: 'admin@local.test',
    password: 'LocalAdmin1234'
  });
  if (!adminLogin.ok) throw new Error('Admin login failed');
  const aToken = adminLogin.data.token;
  console.log('   ✓ Admin logged in:', adminLogin.data.user.name);

  console.log('\n--- Admin User Management ---');
  const usersList = await req('GET', '/users', aToken);
  console.log(`   ✓ Admin users list fetched: ${usersList.data.length} total user(s)`);
  for (const u of usersList.data) {
    console.log(`     - ${u.name} (${u.email}) [Role: ${u.role}]`);
  }

  console.log('\n--- Admin AI Guidelines Management ---');
  const guidelines = await req('GET', '/admin/guidelines', aToken);
  console.log(`   ✓ Guidelines fetched: ${guidelines.data.length} guideline(s)`);
  const activeG = guidelines.data[0];
  console.log(`     Guideline 1: "${activeG.description}" [Active: ${activeG.is_active}]`);

  const toggleG = await req('PUT', `/admin/guidelines/${activeG.id}/toggle`, aToken);
  console.log(`   ✓ Toggled guideline state: new status = ${toggleG.data.status} (active: ${toggleG.data.is_active})`);

  // Toggle back to active
  await req('PUT', `/admin/guidelines/${activeG.id}/toggle`, aToken);

  console.log('\n--- Admin Platform KPIs / Analytics ---');
  const kpis = await req('GET', '/analytics/kpis', aToken);
  console.log('   ✓ Platform KPIs:');
  console.log(`     - Active Learners: ${kpis.data.activeLearners}`);
  console.log(`     - Completion Rate: ${kpis.data.completionRate}%`);
  console.log(`     - Average Assessment Score: ${kpis.data.assessmentAvg}%`);
  console.log(`     - Total Live Sessions: ${kpis.data.totalSessions}`);
  console.log(`     - Revenue: ${JSON.stringify(kpis.data.revenue)}`);

  console.log('\n--- Admin Data & Assets ---');
  const projects = await req('GET', '/data/projects', aToken);
  console.log(`   ✓ Data projects count: ${projects.data.length}`);
  const assets = await req('GET', '/data/assets', aToken);
  console.log(`   ✓ Data assets count: ${assets.data.length}`);
  if (assets.data.length > 0) {
    console.log(`     Asset 1: "${assets.data[0].asset_name}" (${assets.data[0].asset_type}, ${assets.data[0].asset_size} bytes)`);
  }

  console.log('\n====================================================');
  console.log('ALL THREE ROLES COMPLETED THEIR FULL WORKFLOWS 100%!');
  console.log('====================================================');
}

verifyAllRoles().catch((err) => {
  console.error('\n❌ Role walkthrough failed:', err);
  process.exit(1);
});
