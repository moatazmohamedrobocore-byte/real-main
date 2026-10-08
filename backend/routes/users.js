import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../db/pool.js';
import { authenticate, requireRoles } from '../middleware/auth.js';

const router = Router();

function publicUser(u) {
  return {
    id: String(u.id),
    _id: String(u.id),
    email: u.email,
    name: u.name,
    role: u.role,
    avatar: u.avatar || null,
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at
  };
}

// GET / (list users)
router.get('/', authenticate, requireRoles('admin'), async (_req, res, next) => {
  try {
    const result = await query(
      `SELECT id, name, email, role, avatar, created_at, last_login_at
       FROM users
       WHERE deleted_at IS NULL
       ORDER BY created_at DESC`
    );
    res.json(result.rows.map(publicUser));
  } catch (err) {
    next(err);
  }
});

// GET /:id (user details with learning stats)
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    if (req.user.role !== 'admin' && String(req.user.id) !== String(req.params.id)) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You do not have permission to view this profile.' } });
    }

    const userRes = await query(
      `SELECT id, name, email, role, avatar, created_at, last_login_at
       FROM users
       WHERE id = $1 AND deleted_at IS NULL`,
      [req.params.id]
    );

    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: { code: 'USER_NOT_FOUND', message: 'User not found.' } });
    }

    const user = userRes.rows[0];

    const [progRes, enrRes, subRes] = await Promise.all([
      query('SELECT lesson_id FROM lesson_progress WHERE user_id = $1', [user.id]),
      query("SELECT course_id FROM enrollments WHERE student_id = $1 AND status IN ('enrolled', 'completed')", [user.id]),
      query(
        `SELECT assessment_id, grading_score
         FROM submissions
         WHERE student_id = $1 AND kind = 'assessment' AND attempt_status = 'submitted'`,
        [user.id]
      )
    ]);

    res.json({
      ...publicUser(user),
      completed_lessons: progRes.rows.map((p) => String(p.lesson_id)),
      enrolled_courses: enrRes.rows.map((e) => String(e.course_id)),
      completed_tasks: subRes.rows.map((s) => ({
        task_id: String(s.assessment_id),
        score: s.grading_score !== null ? Number(s.grading_score) : null
      }))
    });
  } catch (err) {
    next(err);
  }
});

// GET /:id/learning-summary — student-specific course, session, and assessment progress.
router.get('/:id/learning-summary', authenticate, async (req, res, next) => {
  try {
    if (req.user.role !== 'admin' && String(req.user.id) !== String(req.params.id)) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You cannot view this learning summary.' } });
    }

    const studentId = req.params.id;
    const [coursesResult, assessmentsResult, sessionsResult] = await Promise.all([
      query(
        `SELECT c.id, c.title, c.category, c.difficulty, e.enrolled_at,
                (SELECT COUNT(*) FROM lessons l WHERE l.course_id = c.id) AS total_lessons,
                (SELECT COUNT(*) FROM lesson_progress lp WHERE lp.course_id = c.id AND lp.user_id = $1) AS completed_lessons,
                (SELECT COUNT(*) FROM live_sessions ls WHERE ls.course_id = c.id AND ls.status = 'ended') AS sessions_total,
                (SELECT COUNT(*) FROM attendance_records ar
                   JOIN live_sessions ls ON ls.id = ar.session_id
                 WHERE ls.course_id = c.id AND ar.student_id = $1 AND ar.total_seconds > 0) AS sessions_attended,
                (SELECT ROUND(AVG(latest.grading_score), 2)
                   FROM (SELECT DISTINCT ON (s.assessment_id) s.assessment_id, s.grading_score
                         FROM submissions s JOIN assessments a ON a.id = s.assessment_id
                         WHERE s.student_id = $1 AND a.course_id = c.id AND s.kind = 'assessment'
                           AND s.grading_score IS NOT NULL
                         ORDER BY s.assessment_id, s.attempt_number DESC, s.submitted_at DESC) latest) AS average_grade
         FROM enrollments e
         JOIN courses c ON c.id = e.course_id
         WHERE e.student_id = $1 AND e.status IN ('enrolled', 'completed')
         ORDER BY e.enrolled_at DESC`,
        [studentId]
      ),
      query(
        `SELECT a.id, a.title, a.type, a.course_id, c.title AS course_title,
                a.due_at, a.questions,
                latest.id AS submission_id, latest.attempt_status, latest.grading_status,
                latest.grading_score, latest.submitted_at, latest.attempt_number
         FROM assessments a
         LEFT JOIN courses c ON c.id = a.course_id
         LEFT JOIN LATERAL (
           SELECT s.id, s.attempt_status, s.grading_status, s.grading_score, s.submitted_at, s.attempt_number
           FROM submissions s
           WHERE s.student_id = $1 AND s.assessment_id = a.id AND s.kind = 'assessment'
           ORDER BY s.attempt_number DESC, COALESCE(s.submitted_at, s.started_at, s.created_at) DESC
           LIMIT 1
         ) latest ON true
         WHERE (a.status = 'published' OR latest.id IS NOT NULL)
           AND (a.course_id IS NULL OR EXISTS (
             SELECT 1 FROM enrollments e WHERE e.student_id = $1 AND e.course_id = a.course_id
               AND e.status IN ('enrolled', 'completed')
           ))
         ORDER BY a.due_at NULLS LAST, a.created_at DESC`,
        [studentId]
      ),
      query(
        `SELECT COUNT(*) AS total,
                COUNT(*) FILTER (WHERE ar.total_seconds > 0) AS attended
         FROM live_sessions ls
         JOIN enrollments e ON e.course_id = ls.course_id AND e.student_id = $1
           AND e.status IN ('enrolled', 'completed')
         LEFT JOIN attendance_records ar ON ar.session_id = ls.id AND ar.student_id = $1
         WHERE ls.status = 'ended'`,
        [studentId]
      )
    ]);

    const courses = coursesResult.rows.map((row) => {
      const totalLessons = Number(row.total_lessons) || 0;
      const completedLessons = Number(row.completed_lessons) || 0;
      return {
        id: String(row.id),
        title: row.title,
        category: row.category,
        difficulty: row.difficulty,
        enrolledAt: row.enrolled_at,
        totalLessons,
        completedLessons,
        progress: totalLessons ? Math.round((completedLessons / totalLessons) * 100) : 0,
        sessionsTotal: Number(row.sessions_total) || 0,
        sessionsAttended: Number(row.sessions_attended) || 0,
        averageGrade: row.average_grade === null ? null : Number(row.average_grade)
      };
    });
    const assessments = assessmentsResult.rows.map((row) => {
      const questions = Array.isArray(row.questions) ? row.questions : [];
      const totalMarks = questions.reduce((sum, question) => sum + Number(question.points || question.marks || 1), 0) || null;
      return {
        id: String(row.id),
        title: row.title,
        type: row.type,
        courseId: row.course_id ? String(row.course_id) : null,
        courseTitle: row.course_title || 'All courses',
        dueAt: row.due_at,
        submissionId: row.submission_id ? String(row.submission_id) : null,
        attemptNumber: row.attempt_number === null ? null : Number(row.attempt_number),
        status: row.grading_status === 'graded' ? 'graded' : row.attempt_status || 'not_started',
        score: row.grading_score === null ? null : Number(row.grading_score),
        percentage: row.grading_score === null ? null : Math.max(0, Math.min(100,
          row.grading_status === 'graded' && totalMarks
            ? (Number(row.grading_score) / totalMarks) * 100
            : Number(row.grading_score)
        )),
        totalMarks,
        submittedAt: row.submitted_at
      };
    });

    for (const course of courses) {
      const courseGrades = assessments
        .filter((assessment) => assessment.courseId === course.id && assessment.percentage !== null)
        .map((assessment) => assessment.percentage);
      course.averageGrade = courseGrades.length
        ? Number((courseGrades.reduce((sum, grade) => sum + grade, 0) / courseGrades.length).toFixed(1))
        : null;
    }

    const totalLessons = courses.reduce((sum, course) => sum + course.totalLessons, 0);
    const completedLessons = courses.reduce((sum, course) => sum + course.completedLessons, 0);
    const gradedAssessments = assessments.filter((assessment) => assessment.score !== null);
    const submittedAssessments = assessments.filter((assessment) => ['submitted', 'graded', 'auto_graded'].includes(assessment.status));
    const sessionsTotal = Number(sessionsResult.rows[0]?.total) || 0;
    const sessionsAttended = Number(sessionsResult.rows[0]?.attended) || 0;

    res.json({
      courses,
      assessments,
      stats: {
        coursesEnrolled: courses.length,
        lessonsCompleted: completedLessons,
        lessonsTotal: totalLessons,
        courseProgress: totalLessons ? Math.round((completedLessons / totalLessons) * 100) : 0,
        sessionsAttended,
        sessionsTotal,
        assessmentsAssigned: assessments.length,
        assessmentsCompleted: submittedAssessments.length,
        assessmentsPending: Math.max(0, assessments.length - submittedAssessments.length),
        assessmentAverage: gradedAssessments.length
          ? Number((gradedAssessments.reduce((sum, assessment) => sum + (assessment.percentage ?? 0), 0) / gradedAssessments.length).toFixed(1))
          : 0
      }
    });
  } catch (err) {
    next(err);
  }
});

// PUT /:id/role and PATCH /:id/role
async function updateRoleHandler(req, res, next) {
  try {
    const { role } = req.body || {};
    if (!['student', 'admin'].includes(role)) {
      return res.status(400).json({ error: { code: 'INVALID_ROLE', message: 'Role must be student or admin.' } });
    }

    const result = await query(
      `UPDATE users
       SET role = $1, updated_at = now()
       WHERE id = $2 AND deleted_at IS NULL
       RETURNING id, name, email, role, avatar`,
      [role, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { code: 'USER_NOT_FOUND', message: 'User not found.' } });
    }

    res.json(publicUser(result.rows[0]));
  } catch (err) {
    next(err);
  }
}
router.put('/:id/role', authenticate, requireRoles('admin'), updateRoleHandler);
router.patch('/:id/role', authenticate, requireRoles('admin'), updateRoleHandler);

// PUT /:id/profile and PATCH /:id/profile
async function updateProfileHandler(req, res, next) {
  try {
    if (req.user.role !== 'admin' && String(req.user.id) !== String(req.params.id)) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Cannot update another user profile.' } });
    }

    const { name, avatar, password } = req.body || {};
    const existing = await query('SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL', [req.params.id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: { code: 'USER_NOT_FOUND', message: 'User not found.' } });
    }

    const u = existing.rows[0];
    const newName = name !== undefined ? name.trim() : u.name;
    const newAvatar = avatar !== undefined ? avatar : u.avatar;
    let newHash = u.password_hash;
    if (password && password.length >= 6) {
      newHash = await bcrypt.hash(password, 12);
    }

    const result = await query(
      `UPDATE users
       SET name = $1, avatar = $2, password_hash = $3, updated_at = now()
       WHERE id = $4
       RETURNING id, name, email, role, avatar`,
      [newName, newAvatar, newHash, req.params.id]
    );

    res.json(publicUser(result.rows[0]));
  } catch (err) {
    next(err);
  }
}
router.put('/:id/profile', authenticate, updateProfileHandler);
router.patch('/:id/profile', authenticate, updateProfileHandler);

// GET /:id/results
router.get('/:id/results', authenticate, async (req, res, next) => {
  try {
    const results = await query(
      `SELECT qr.*, a.title as task_title
       FROM quiz_results qr
       LEFT JOIN assessments a ON a.id::text = qr.task_id
       WHERE qr.student_id = $1`,
      [req.params.id]
    );
    res.json(results.rows);
  } catch (err) {
    next(err);
  }
});

// POST /:userId/lessons/:lessonId/toggle and POST /:id/toggle-lesson
async function toggleLessonHandler(req, res, next) {
  try {
    const userId = req.params.userId || req.params.id || req.user.id;
    const lessonId = req.params.lessonId || req.body?.lessonId;

    if (req.user.role !== 'admin' && String(req.user.id) !== String(userId)) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Cannot modify progress for other users.' } });
    }

    const lessonRes = await query('SELECT course_id FROM lessons WHERE id = $1', [lessonId]);
    if (lessonRes.rows.length === 0) {
      return res.status(404).json({ error: { code: 'LESSON_NOT_FOUND', message: 'Lesson not found.' } });
    }
    const courseId = lessonRes.rows[0].course_id;

    const existingProg = await query('SELECT id FROM lesson_progress WHERE user_id = $1 AND lesson_id = $2', [userId, lessonId]);
    if (existingProg.rows.length > 0) {
      await query('DELETE FROM lesson_progress WHERE id = $1', [existingProg.rows[0].id]);
    } else {
      await query(
        `INSERT INTO lesson_progress (user_id, lesson_id, course_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, lesson_id) DO NOTHING`,
        [userId, lessonId, courseId]
      );
    }

    const updatedProg = await query('SELECT lesson_id FROM lesson_progress WHERE user_id = $1', [userId]);
    res.json({
      success: true,
      completed_lessons: updatedProg.rows.map((p) => String(p.lesson_id))
    });
  } catch (err) {
    next(err);
  }
}
router.post('/:userId/lessons/:lessonId/toggle', authenticate, toggleLessonHandler);
router.post('/:id/toggle-lesson', authenticate, toggleLessonHandler);

// DELETE /:id
router.delete('/:id', authenticate, requireRoles('admin'), async (req, res, next) => {
  try {
    await query('UPDATE users SET deleted_at = now() WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'User deleted.' });
  } catch (err) {
    next(err);
  }
});

export default router;
