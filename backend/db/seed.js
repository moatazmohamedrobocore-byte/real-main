import bcrypt from 'bcryptjs';
import { pool } from './pool.js';

async function seed() {
  console.log('Seeding PostgreSQL database...');
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Seed Users
    const users = [
      { email: 'admin@local.test', name: 'Local Admin', role: 'admin', password: 'LocalAdmin1234' },
      { email: 'admin2@local.test', name: 'Local Admin 2', role: 'admin', password: 'LocalAdmin1234' },
      { email: 'student@local.test', name: 'Local Student', role: 'student', password: 'LocalStudent1234' }
    ];

    const userMap = {};
    for (const u of users) {
      const hash = await bcrypt.hash(u.password, 10);
      const res = await client.query(
        `INSERT INTO users (email, password_hash, name, role)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (email) DO UPDATE
         SET name = EXCLUDED.name, role = EXCLUDED.role, password_hash = EXCLUDED.password_hash
         RETURNING id, email, role, name`,
        [u.email, hash, u.name, u.role]
      );
      userMap[u.email] = res.rows[0];
      console.log(`Seeded user: ${u.email} (${u.role})`);
    }

    const instructorId = userMap['admin2@local.test'].id;
    const studentId = userMap['student@local.test'].id;
    const adminId = userMap['admin@local.test'].id;

    // 2. Seed Courses
    const course1Res = await client.query(
      `INSERT INTO courses (title, description, category, difficulty, pricing_access, instructor_id, status, enrollment_open, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
       RETURNING id`,
      [
        'REAL_i Local Demo Course',
        'A complete introduction to the REAL_i learning platform, featuring interactive multi-agent AI and live classrooms.',
        'Getting Started',
        'beginner',
        'free',
        instructorId,
        'published',
        true
      ]
    );
    const course1Id = course1Res.rows[0].id;

    const course2Res = await client.query(
      `INSERT INTO courses (title, description, category, difficulty, pricing_access, instructor_id, status, enrollment_open, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
       RETURNING id`,
      [
        'Advanced AI Architectures',
        'Master multi-agent systems, RAG retrieval pipelines, and vector databases.',
        'AI & ML',
        'advanced',
        'free',
        instructorId,
        'published',
        true
      ]
    );
    const course2Id = course2Res.rows[0].id;

    console.log('Seeded courses:', course1Id, course2Id);

    // 3. Seed Lessons
    await client.query(
      `INSERT INTO lessons (course_id, title, content, position, status, published_at)
       VALUES 
       ($1, 'Welcome to REAL_i', 'REAL_i is a learning platform built on an Express API and a PostgreSQL database. Students enroll in published courses, complete interactive lessons, take assessments, and join live classroom sessions.', 1, 'published', now()),
       ($1, 'Understanding Agent Tutoring', 'In this lesson, you will learn how the AI Tutor Raaed answers course questions and assists students in real-time.', 2, 'published', now())
       ON CONFLICT (course_id, position) DO NOTHING`,
      [course1Id]
    );

    await client.query(
      `INSERT INTO lessons (course_id, title, content, position, status, published_at)
       VALUES 
       ($1, 'Multi-Agent Coordination Patterns', 'Study the foundational coordination paradigms between specialized autonomous reasoning agents.', 1, 'published', now())
       ON CONFLICT (course_id, position) DO NOTHING`,
      [course2Id]
    );
    console.log('Seeded lessons');

    // 4. Seed Enrollments
    await client.query(
      `INSERT INTO enrollments (student_id, course_id, status, enrolled_at)
       VALUES ($1, $2, 'enrolled', now())
       ON CONFLICT DO NOTHING`,
      [studentId, course1Id]
    );
    await client.query(
      `INSERT INTO enrollments (student_id, course_id, status, enrolled_at)
       VALUES ($1, $2, 'enrolled', now())
       ON CONFLICT DO NOTHING`,
      [studentId, course2Id]
    );
    console.log('Seeded enrollments');

    // 5. Seed Assessment
    const questions = [
      {
        id: 'q1',
        type: 'mcq',
        prompt: 'Which database backs the REAL_i platform?',
        options: [
          { id: 'opt1', text: 'PostgreSQL' },
          { id: 'opt2', text: 'Static CDN' },
          { id: 'opt3', text: 'Legacy Cache' },
          { id: 'opt4', text: 'External Proxy' }
        ],
        correctOptionIds: ['opt1'],
        points: 5
      },
      {
        id: 'q2',
        type: 'true_false',
        prompt: 'REAL_i supports live interactive virtual classrooms powered by Jitsi.',
        options: [
          { id: 'true', text: 'True' },
          { id: 'false', text: 'False' }
        ],
        correctOptionIds: ['true'],
        points: 5
      }
    ];

    await client.query(
      `INSERT INTO assessments (course_id, author_id, title, instructions, status, time_limit_seconds, questions, published_at)
       VALUES ($1, $2, $3, $4, 'published', 600, $5, now())`,
      [course1Id, instructorId, 'Getting Started Quiz', 'Answer the questions based on the introductory lesson.', JSON.stringify(questions)]
    );
    console.log('Seeded assessments');

    // 6. Seed Meetings (Live Sessions)
    const now = new Date();
    const meetingRes = await client.query(
      `INSERT INTO live_sessions (course_id, host_id, provider, provider_room_id, title, description, starts_at, ends_at, status)
       VALUES 
       ($1, $2, 'jitsi', 'reali-local-orientation', 'REAL_i Live Orientation', 'Welcome live session for new students.', $3, $4, 'live')
       ON CONFLICT (provider_room_id) DO UPDATE SET status = 'live'
       RETURNING id`,
      [course1Id, instructorId, new Date(now.getTime() - 15 * 60 * 1000), new Date(now.getTime() + 2 * 60 * 60 * 1000)]
    );
    const meetingId = meetingRes.rows[0]?.id;

    // Seed meeting attendance
    if (meetingId) {
      await client.query(
        `INSERT INTO attendance_records (session_id, course_id, student_id, total_seconds, intervals)
         VALUES ($1, $2, $3, 300, $4)
         ON CONFLICT (session_id, student_id) DO NOTHING`,
        [meetingId, course1Id, studentId, JSON.stringify([{ joinedAt: new Date(now.getTime() - 10 * 60 * 1000), leftAt: new Date(now.getTime() - 5 * 60 * 1000) }])]
      );
    }
    console.log('Seeded live sessions');

    // 7. Seed Calendar Events
    await client.query(
      `INSERT INTO calendar_events (scope, title, description, starts_at, status, created_by)
       VALUES 
       ('global', 'Semester Kickoff', 'Welcome orientation session for all students.', $1, 'active', $2),
       ('course', 'Assessment 1 Due Date', 'Deadline for completing Getting Started Quiz.', $3, 'active', $2)`,
      [new Date(now.getTime() + 24 * 60 * 60 * 1000), adminId, new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000)]
    );
    console.log('Seeded calendar events');

    // 8. Seed AI Guidelines
    await client.query(
      `INSERT INTO ai_guidelines (scope, version, status, content, created_by, activated_at)
       VALUES ('global', 1, 'active', 'Provide clear, encouraging, and academically rigorous guidance to students.', $1, now())
       ON CONFLICT DO NOTHING`,
      [adminId]
    );
    console.log('Seeded AI guidelines');

    // 9. Seed Data Assets
    await client.query(
      `INSERT INTO data_assets (course_id, asset_name, asset_type, asset_size, uploaded_by)
       VALUES ($1, 'course_syllabus.pdf', 'pdf', 1048576, $2)`,
      [course1Id, instructorId]
    );
    console.log('Seeded data assets');

    await client.query('COMMIT');
    console.log('Seeding completed successfully!');
    console.log('==============================================');
    console.log('Seeded accounts (login at http://localhost:3001/login):');
    for (const u of users) {
      console.log(`  ${u.role.padEnd(10)} ${u.email}  /  ${u.password}`);
    }
    console.log('==============================================');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Seeding failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
