import { Router } from 'express';
import multer from 'multer';
import { pool, query } from '../db/pool.js';
import { authenticate, requireRoles } from '../middleware/auth.js';

const router = Router();
const assignmentFileExtensions = new Set(['.pdf', '.doc', '.docx', '.zip', '.rar', '.py', '.ipynb', '.js', '.ts', '.java', '.c', '.cpp', '.txt']);
const assignmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 10, fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    const extension = file.originalname.toLowerCase().match(/\.[^.]+$/)?.[0];
    callback(extension && assignmentFileExtensions.has(extension) ? null : Object.assign(new Error('Upload a PDF, document, ZIP/RAR archive, or supported code/text file.'), { status: 400 }), Boolean(extension && assignmentFileExtensions.has(extension)));
  }
});
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeCourseId(value) {
  if (value === undefined || value === null || value === '' || /^(general|global)( \(all courses\))?$/i.test(String(value))) return null;
  return UUID_RE.test(String(value)) ? String(value) : undefined;
}

async function lockStudentAssessmentAttempt(client, studentId, assessmentId) {
  // Serialize starts/submissions so concurrent requests cannot both pass the limit.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${studentId}:${assessmentId}`]);
  const result = await client.query(
    'SELECT COUNT(*)::int AS count FROM submissions WHERE student_id = $1 AND assessment_id = $2',
    [studentId, assessmentId]
  );
  return Number(result.rows[0]?.count || 0);
}

function attemptLimitError(res) {
  return res.status(409).json({
    error: { code: 'MAX_ATTEMPTS_EXCEEDED', message: 'Attempt limit reached for this assessment.' }
  });
}

// ---- Grading + attempt-lifecycle helpers (F-09, F-10) ----------------------------------------
// Question types that a machine cannot grade. They are never auto-scored and always send the
// submission to manual review, even if the author attached an (empty) answer key.
const OPEN_QUESTION_TYPES = new Set(['essay', 'short_answer', 'long_answer', 'text', 'code', 'file', 'open', 'open_ended']);
// Small allowance for network latency / clock skew between the browser timer and the server.
const ATTEMPT_GRACE_MS = Number(process.env.ATTEMPT_GRACE_SECONDS ?? 5) * 1000;
// When true, timed quizzes/exams can only be submitted for an attempt started via /start, so the
// server owns the clock. Off by default because the shipped exam page submits without starting.
const REQUIRE_ATTEMPT_FOR_TIMED = String(process.env.REQUIRE_ATTEMPT_FOR_TIMED || '').toLowerCase() === 'true';

function normalizeAnswerSet(value) {
  const list = Array.isArray(value) ? value : [value];
  return new Set(
    list
      .filter((v) => v !== undefined && v !== null && String(v).trim() !== '')
      .map((v) => String(v).trim().toLowerCase())
  );
}

function answerKey(q) {
  const raw = Array.isArray(q.correctOptionIds) && q.correctOptionIds.length
    ? q.correctOptionIds
    : (q.correctIndex !== undefined && q.correctIndex !== null ? [q.correctIndex] : []);
  return normalizeAnswerSet(raw);
}

function isAutoGradableQuestion(q) {
  if (OPEN_QUESTION_TYPES.has(String(q.type || '').toLowerCase())) return false;
  return answerKey(q).size > 0;
}

// Decide how a submission is graded. Fully machine-gradable => auto_graded with a score.
// Anything with an open-ended or key-less question => manual_review with NO score yet, so an
// essay is never silently recorded as 0%.
function classifyGrading(questions, grade, hasContent) {
  if (!hasContent) return { status: 'pending', score: null };
  const qs = Array.isArray(questions) ? questions : [];
  const allAuto = qs.length > 0 && qs.every(isAutoGradableQuestion);
  return allAuto ? { status: 'auto_graded', score: grade.percentage } : { status: 'manual_review', score: null };
}

function isAttemptExpired(sub, nowMs = Date.now()) {
  return Boolean(sub.expires_at) && nowMs > new Date(sub.expires_at).getTime() + ATTEMPT_GRACE_MS;
}

// Close an overdue attempt using ONLY the answers that were saved before the deadline. Answers
// that arrive after the time limit are discarded. `exec` is (sql, params) => Promise so the same
// helper works on the pool and inside a transaction.
async function finalizeExpiredAttempt(exec, sub) {
  const snapshot = sub.question_snapshot || [];
  const grade = gradeResponses(snapshot, sub.responses || []);
  const cls = classifyGrading(snapshot, grade, grade.answered > 0);
  const gradedAt = cls.status === 'auto_graded' ? new Date() : null;
  const r = await exec(
    `UPDATE submissions
     SET attempt_status = 'timed_out', submitted_at = now(), expiration_reason = 'time_limit',
         finalization_reason = 'timeout', grading_status = $1::text, grading_score = $2::numeric,
         graded_at = COALESCE($3::timestamptz, graded_at), updated_at = now()
     WHERE id = $4 AND attempt_status = 'in_progress'
     RETURNING *`,
    [cls.status, cls.score, gradedAt, sub.id]
  );
  return { row: r.rows[0] || null, score: cls.score };
}

function sendAttemptExpired(res, fin) {
  return res.status(409).json({
    error: { code: 'ATTEMPT_EXPIRED', message: 'The time limit for this attempt has passed. Only the answers saved before the deadline were submitted.' },
    submission: publicSubmission(fin.row),
    score: fin.score
  });
}

function normalizeAssessmentQuestions(questions) {
  if (!Array.isArray(questions)) return [];
  return questions.map((q, idx) => {
    const rawOptions = q.options || [];
    const options = Array.isArray(rawOptions)
      ? rawOptions
      : rawOptions && typeof rawOptions === 'object'
        ? (() => {
            const letterOptions = ['A', 'B', 'C', 'D'].map((key) => rawOptions[key]).filter((value) => value !== undefined && value !== null && value !== '');
            return letterOptions.length ? letterOptions : Object.values(rawOptions).filter((value) => value !== undefined && value !== null && value !== '');
          })()
        : [];
    const rawCorrect = Array.isArray(q.correctOptionIds) && q.correctOptionIds.length
      ? q.correctOptionIds
      : (q.correctAnswer ?? q.correct_answer ?? []);
    const correctOptionIds = (Array.isArray(rawCorrect) ? rawCorrect : [rawCorrect]).map((answer) => {
      if (typeof answer === 'string' && /^[A-D]$/i.test(answer.trim())) return ['A', 'B', 'C', 'D'].indexOf(answer.trim().toUpperCase());
      return answer;
    }).filter((answer) => answer !== undefined && answer !== null && answer !== '');

    return {
      id: q.id || `q-${idx + 1}`,
      type: q.type || 'mcq',
      prompt: q.prompt || q.text || q.question || `Question ${idx + 1}`,
      options,
      correctOptionIds,
      points: Number(q.points || q.marks || 1),
      rubric: q.rubric || []
    };
  });
}

function normalizeAssessmentResponses(questions, responses) {
  if (Array.isArray(responses)) return responses;
  if (!responses || typeof responses !== 'object') return [];
  return Object.entries(responses).flatMap(([key, rawValue]) => {
    const question = questions.find((q, index) => q.id === key || String(index) === key);
    if (!question) return [];
    const value = typeof rawValue === 'string' && /^[A-D]$/i.test(rawValue.trim())
      ? ['A', 'B', 'C', 'D'].indexOf(rawValue.trim().toUpperCase())
      : rawValue;
    return [{ questionId: question.id, value }];
  });
}

// Student-facing view of a submissions row: never expose the frozen question snapshot,
// which contains the answer key (correctOptionIds).
function publicSubmission(row) {
  if (!row) return row;
  const { question_snapshot, ...rest } = row;
  return rest;
}

function formatAssessment(a) {
  const questions = normalizeAssessmentQuestions(typeof a.questions === 'string' ? JSON.parse(a.questions) : (a.questions || []));
  return {
    id: String(a.id),
    _id: String(a.id),
    courseId: a.course_id ? String(a.course_id) : null,
    course_id: a.course_id ? String(a.course_id) : null,
    authorId: String(a.author_id),
    title: a.title,
    description: a.instructions || '',
    instructions: a.instructions || '',
    type: a.type || 'quiz',
    status: a.status,
    is_published: a.status === 'published',
    timeLimitSeconds: a.time_limit_seconds,
    timeLimit: Math.round(a.time_limit_seconds / 60),
    randomizeQuestions: a.randomize_questions,
    maxAttempts: 1,
    attempts: 1,
    availableFrom: a.available_from,
    startDate: a.available_from,
    dueAt: a.due_at,
    endDate: a.due_at,
    questions: questions.map((q) => ({
      id: q.id,
      text: q.prompt,
      prompt: q.prompt,
      type: q.type,
      options: q.options || [],
      marks: q.points || 1,
      points: q.points || 1,
      rubric: q.rubric || []
    })),
    totalMarks: questions.reduce((acc, q) => acc + (q.points || 1), 0),
    passingGrade: 60,
    publishedAt: a.published_at,
    createdAt: a.created_at,
    updatedAt: a.updated_at
  };
}

// GET /assessments
router.get('/assessments', authenticate, async (req, res, next) => {
  try {
    const courseId = req.query.courseId || req.query.course_id;
    const { status, type } = req.query;

    let sql = 'SELECT a.* FROM assessments a WHERE 1=1';
    const params = [];

    if (req.user.role === 'student') {
      params.push(req.user.id);
      sql += ` AND a.status = 'published' AND (a.course_id IS NULL OR EXISTS (
        SELECT 1 FROM enrollments e
        WHERE e.student_id = $${params.length} AND e.course_id = a.course_id AND e.status IN ('enrolled', 'completed')
      ))`;
    }
    if (courseId) {
      params.push(courseId);
      sql += ` AND a.course_id = $${params.length}`;
    }
    if (status) {
      params.push(status);
      sql += ` AND a.status = $${params.length}`;
    }
    if (type) {
      params.push(type);
      sql += ` AND a.type = $${params.length}`;
    }

    sql += ' ORDER BY a.created_at DESC';
    const result = await query(sql, params);
    res.json(result.rows.map(formatAssessment));
  } catch (err) {
    next(err);
  }
});

// GET /assessments/student/me
router.get('/assessments/student/me', authenticate, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT s.*, a.title as assessment_title, a.type as assessment_type,
              a.due_at, a.questions as assessment_questions, c.title as course_title,
              COALESCE(files.items, '[]'::jsonb) AS files
       FROM submissions s
       LEFT JOIN assessments a ON a.id = s.assessment_id
       LEFT JOIN courses c ON c.id = s.course_id
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(jsonb_build_object(
           'id', f.id, 'originalName', f.original_name, 'mimeType', f.mime_type,
           'fileSize', f.file_size, 'createdAt', f.created_at
         ) ORDER BY f.created_at, f.id) AS items
         FROM assessment_submission_files f WHERE f.submission_id = s.id
       ) files ON true
       WHERE s.student_id = $1 AND s.kind = 'assessment'
       ORDER BY COALESCE(s.submitted_at, s.started_at, s.created_at) DESC`,
      [req.user.id]
    );
    // F-03: question_snapshot / assessment_questions carry the answer key (correctOptionIds).
    // Students must never receive them, in-progress or after submission, so they are
    // used only to compute total_marks and are then dropped from the payload.
    res.json(result.rows.map(({ question_snapshot, assessment_questions, ...row }) => ({
      ...row,
      id: String(row.id),
      assessment_id: row.assessment_id ? String(row.assessment_id) : null,
      score: row.grading_score === null ? null : Number(row.grading_score),
      total_marks: (question_snapshot || assessment_questions || []).reduce((sum, question) => sum + Number(question.points || question.marks || 1), 0) || null,
      status: row.grading_status === 'graded' ? 'graded' : row.attempt_status,
      files: (row.files || []).map((file) => ({ ...file, id: String(file.id) }))
    })));
  } catch (err) {
    next(err);
  }
});

// GET /assessments/students/:studentId/submissions (admin Student Dossier)
router.get('/assessments/students/:studentId/submissions', authenticate, requireRoles('admin'), async (req, res, next) => {
  try {
    const result = await query(
      `SELECT s.*, a.title AS assessment_title, a.type AS assessment_type,
              a.due_at, a.questions AS assessment_questions, c.title AS course_title,
              COALESCE(files.items, '[]'::jsonb) AS files
       FROM submissions s
       LEFT JOIN assessments a ON a.id = s.assessment_id
       LEFT JOIN courses c ON c.id = s.course_id
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(jsonb_build_object(
           'id', f.id, 'originalName', f.original_name, 'mimeType', f.mime_type,
           'fileSize', f.file_size, 'createdAt', f.created_at
         ) ORDER BY f.created_at, f.id) AS items
         FROM assessment_submission_files f WHERE f.submission_id = s.id
       ) files ON true
       WHERE s.student_id = $1 AND s.kind = 'assessment'
       ORDER BY COALESCE(s.submitted_at, s.started_at, s.created_at) DESC`,
      [req.params.studentId]
    );
    res.json(result.rows.map((row) => ({
      ...row,
      id: String(row.id),
      assessment_id: row.assessment_id ? String(row.assessment_id) : null,
      score: row.grading_score === null ? null : Number(row.grading_score),
      total_marks: (row.question_snapshot || row.assessment_questions || []).reduce((sum, question) => sum + Number(question.points || question.marks || 1), 0) || null,
      status: row.grading_status === 'graded' ? 'graded' : row.attempt_status,
      files: (row.files || []).map((file) => ({ ...file, id: String(file.id) }))
    })));
  } catch (err) {
    next(err);
  }
});

router.get('/assessments/:id', authenticate, async (req, res, next) => {
  try {
    const result = await query('SELECT * FROM assessments WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: { code: 'ASSESSMENT_NOT_FOUND', message: 'Assessment not found.' } });
    }

    const assessment = result.rows[0];
    if (req.user.role === 'student') {
      const enrollment = assessment.course_id
        ? await query(
            "SELECT 1 FROM enrollments WHERE student_id = $1 AND course_id = $2 AND status IN ('enrolled', 'completed')",
            [req.user.id, assessment.course_id]
          )
        : { rows: [{}] };
      if (assessment.status !== 'published' || enrollment.rows.length === 0) {
        return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'This assessment is not available to you.' } });
      }
    }

    res.json(formatAssessment(assessment));
  } catch (err) {
    next(err);
  }
});

// POST /courses/:courseId/assessments and POST /assessments
async function createAssessmentHandler(req, res, next) {
  try {
    const rawCourseId = req.params.courseId || req.body.courseId || req.body.course_id;
    const courseId = normalizeCourseId(rawCourseId);
    const { title, instructions, description, type = 'quiz', status = 'draft', timeLimitSeconds = 600, randomizeQuestions = true, availableFrom, dueAt, questions = [] } = req.body || {};
    const rawMaxAttempts = req.body?.maxAttempts ?? req.body?.max_attempts ?? req.body?.attempts ?? 1;
    const maxAttempts = Math.min(20, Math.max(1, Number(rawMaxAttempts) || 1));

    if (!title?.trim()) {
      return res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Title is required.' } });
    }
    if (courseId === undefined) {
      return res.status(400).json({ error: { code: 'INVALID_COURSE', message: 'Select a valid course or General (All Courses).' } });
    }
    if (!['quiz', 'exam', 'assignment', 'task'].includes(type)) {
      return res.status(400).json({ error: { code: 'INVALID_TYPE', message: 'Assessment type must be quiz, exam, assignment, or task.' } });
    }

    const formattedQuestions = normalizeAssessmentQuestions(questions);

    const result = await query(
      `INSERT INTO assessments (course_id, author_id, title, instructions, type, status, time_limit_seconds, randomize_questions, max_attempts, available_from, due_at, questions, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [
        courseId,
        req.user.id,
        title.trim(),
        instructions || description || '',
        type,
        status,
        timeLimitSeconds,
        randomizeQuestions,
        maxAttempts,
        availableFrom || null,
        dueAt || null,
        JSON.stringify(formattedQuestions),
        status === 'published' ? new Date() : null
      ]
    );

    res.status(201).json(formatAssessment(result.rows[0]));
  } catch (err) {
    next(err);
  }
}

router.post('/courses/:courseId/assessments', authenticate, requireRoles('admin'), createAssessmentHandler);
router.post('/assessments', authenticate, requireRoles('admin'), createAssessmentHandler);

// PATCH /assessments/:id and PUT /assessments/:id
async function updateAssessmentHandler(req, res, next) {
  try {
    const existing = await query('SELECT * FROM assessments WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: { code: 'ASSESSMENT_NOT_FOUND', message: 'Assessment not found.' } });
    }

    const a = existing.rows[0];
    const { title, instructions, type, status, timeLimitSeconds, randomizeQuestions, availableFrom, dueAt, questions } = req.body || {};
    if (type !== undefined && !['quiz', 'exam', 'assignment', 'task'].includes(type)) {
      return res.status(400).json({ error: { code: 'INVALID_TYPE', message: 'Assessment type must be quiz, exam, assignment, or task.' } });
    }

    const newTitle = title !== undefined ? title.trim() : a.title;
    const newInstructions = instructions !== undefined ? instructions : a.instructions;
    const newType = type !== undefined ? type : a.type;
    const newStatus = status !== undefined ? status : a.status;
    const newTimeLimit = timeLimitSeconds !== undefined ? timeLimitSeconds : a.time_limit_seconds;
    const newRandom = randomizeQuestions !== undefined ? randomizeQuestions : a.randomize_questions;
    const newAttempts = 1;
    const newAvail = availableFrom !== undefined ? availableFrom : a.available_from;
    const newDue = dueAt !== undefined ? dueAt : a.due_at;
    const newQuestions = questions !== undefined ? JSON.stringify(normalizeAssessmentQuestions(questions)) : a.questions;
    const publishedAt = newStatus === 'published' && !a.published_at ? new Date() : a.published_at;

    const result = await query(
      `UPDATE assessments
       SET title = $1, instructions = $2, type = $3, status = $4, time_limit_seconds = $5,
           randomize_questions = $6, max_attempts = $7, available_from = $8,
           due_at = $9, questions = $10, published_at = $11, updated_at = now()
       WHERE id = $12
       RETURNING *`,
      [newTitle, newInstructions, newType, newStatus, newTimeLimit, newRandom, newAttempts, newAvail, newDue, newQuestions, publishedAt, req.params.id]
    );

    res.json(formatAssessment(result.rows[0]));
  } catch (err) {
    next(err);
  }
}

router.patch('/assessments/:id', authenticate, requireRoles('admin'), updateAssessmentHandler);
router.put('/assessments/:id', authenticate, requireRoles('admin'), updateAssessmentHandler);

// POST /assessments/:id/publish & PATCH /assessments/:id/publish
async function publishAssessmentHandler(req, res, next) {
  try {
    const result = await query(
      `UPDATE assessments
       SET status = 'published', published_at = COALESCE(published_at, now()), updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: { code: 'ASSESSMENT_NOT_FOUND', message: 'Assessment not found.' } });
    }
    res.json(formatAssessment(result.rows[0]));
  } catch (err) {
    next(err);
  }
}
router.post('/assessments/:id/publish', authenticate, requireRoles('admin'), publishAssessmentHandler);
router.patch('/assessments/:id/publish', authenticate, requireRoles('admin'), publishAssessmentHandler);

// DELETE /assessments/:id
router.delete('/assessments/:id', authenticate, requireRoles('admin'), async (req, res, next) => {
  try {
    await query('DELETE FROM assessments WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'Assessment deleted.' });
  } catch (err) {
    next(err);
  }
});

// POST /assessments/:id/start (start attempt)
router.post('/assessments/:id/start', authenticate, async (req, res, next) => {
  try {
    const assessRes = await query('SELECT * FROM assessments WHERE id = $1', [req.params.id]);
    if (assessRes.rows.length === 0) {
      return res.status(404).json({ error: { code: 'ASSESSMENT_NOT_FOUND', message: 'Assessment not found.' } });
    }

    const a = assessRes.rows[0];
    const now = new Date();

    // F-04: the assessment must be published, and students must be enrolled in its course.
    // Staff (admin/instructor) may start regardless. Never trust client-supplied course/role.
    const isStaff = req.user.role === 'admin' || req.user.role === 'instructor';
    if (!isStaff && a.status !== 'published') {
      return res.status(404).json({ error: { code: 'ASSESSMENT_NOT_FOUND', message: 'Assessment not found.' } });
    }
    if (!isStaff && a.course_id) {
      const enr = await query(
        "SELECT 1 FROM enrollments WHERE student_id = $1 AND course_id = $2 AND status IN ('enrolled','completed')",
        [req.user.id, a.course_id]
      );
      if (enr.rows.length === 0) {
        return res.status(403).json({ error: { code: 'ENROLLMENT_REQUIRED', message: 'Enroll in this course before starting the assessment.' } });
      }
    }

    // 1. Check due_at FIRST before max_attempts
    if (a.due_at && now > new Date(a.due_at)) {
      return res.status(400).json({
        error: {
          code: 'ASSESSMENT_PAST_DUE',
          message: 'Assessment deadline has passed. No new attempts are permitted.'
        }
      });
    }

    if (a.available_from && now < new Date(a.available_from)) {
      return res.status(400).json({
        error: {
          code: 'ASSESSMENT_NOT_YET_AVAILABLE',
          message: 'Assessment is not yet available.'
        }
      });
    }

    const questions = typeof a.questions === 'string' ? JSON.parse(a.questions) : a.questions;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const previousCount = await lockStudentAssessmentAttempt(client, req.user.id, a.id);
      const prior = await client.query(
        `SELECT * FROM submissions
         WHERE student_id = $1 AND assessment_id = $2
         ORDER BY attempt_number DESC, created_at DESC LIMIT 1`,
        [req.user.id, a.id]
      );

      if (prior.rows.length) {
        const existing = prior.rows[0];
        if (previousCount === 1 && existing.attempt_status === 'in_progress' && existing.expires_at && new Date(existing.expires_at) > now) {
          await client.query('COMMIT');
          const savedQuestions = existing.question_snapshot || questions;
          return res.json({
            id: String(existing.id),
            submissionId: String(existing.id),
            assessmentId: String(a.id),
            attemptNumber: 1,
            startedAt: existing.started_at,
            expiresAt: existing.expires_at,
            questions: savedQuestions.map((q) => ({ id: q.id, prompt: q.prompt, type: q.type, options: q.options, points: q.points }))
          });
        }
        if (existing.attempt_status === 'in_progress' && isAttemptExpired(existing)) {
          await finalizeExpiredAttempt((t, p) => client.query(t, p), existing);
          await client.query('COMMIT');
          return attemptLimitError(res);
        }
        await client.query('ROLLBACK');
        return attemptLimitError(res);
      }

      const expiresAt = new Date(now.getTime() + a.time_limit_seconds * 1000);
      const result = await client.query(
        `INSERT INTO submissions (student_id, course_id, assessment_id, kind, attempt_number, submission_type, responses, started_at, expires_at, attempt_status, question_snapshot)
         VALUES ($1, $2, $3, 'assessment', 1, 'mcq', '[]'::jsonb, $4, $5, 'in_progress', $6)
         RETURNING *`,
        [req.user.id, a.course_id, a.id, now, expiresAt, JSON.stringify(questions)]
      );
      await client.query('COMMIT');
      const submission = result.rows[0];
      return res.status(201).json({
      id: String(submission.id),
      submissionId: String(submission.id),
      assessmentId: String(a.id),
      attemptNumber: 1,
      startedAt: submission.started_at,
      expiresAt: submission.expires_at,
      questions: questions.map((q) => ({ id: q.id, prompt: q.prompt, type: q.type, options: q.options, points: q.points }))
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

// GET /attempts/:submissionId
router.get('/attempts/:submissionId', authenticate, async (req, res, next) => {
  try {
    // F-05: scope to the owner; staff may view any. Non-owners get 404 (no existence leak).
    const isStaff = req.user.role === 'admin' || req.user.role === 'instructor';
    const result = await query(
      'SELECT * FROM submissions WHERE id = $1 AND ($2 OR student_id = $3)',
      [req.params.submissionId, isStaff, req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: { code: 'ATTEMPT_NOT_FOUND', message: 'Attempt not found.' } });
    }
    const sub = result.rows[0];
    res.json({
      id: String(sub.id),
      submissionId: String(sub.id),
      assessmentId: String(sub.assessment_id),
      attemptStatus: sub.attempt_status,
      responses: sub.responses || [],
      score: sub.grading_score,
      gradingStatus: sub.grading_status,
      startedAt: sub.started_at,
      expiresAt: sub.expires_at,
      submittedAt: sub.submitted_at
    });
  } catch (err) {
    next(err);
  }
});

// PUT /attempts/:submissionId/answers
router.put('/attempts/:submissionId/answers', authenticate, async (req, res, next) => {
  try {
    const { responses } = req.body || {};
    const current = await query(
      "SELECT * FROM submissions WHERE id = $1 AND student_id = $2 AND attempt_status = 'in_progress'",
      [req.params.submissionId, req.user.id]
    );
    if (current.rows.length && isAttemptExpired(current.rows[0])) {
      return sendAttemptExpired(res, await finalizeExpiredAttempt(query, current.rows[0]));
    }
    const result = await query(
      `UPDATE submissions
       SET responses = $1, updated_at = now()
       WHERE id = $2 AND student_id = $3 AND attempt_status = 'in_progress'
       RETURNING *`,
      [JSON.stringify(responses || []), req.params.submissionId, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { code: 'ATTEMPT_NOT_FOUND', message: 'Active attempt not found.' } });
    }
    res.json({ success: true, responses: result.rows[0].responses });
  } catch (err) {
    next(err);
  }
});

// POST /attempts/:submissionId/submit
router.post('/attempts/:submissionId/submit', authenticate, async (req, res, next) => {
  try {
    const subRes = await query('SELECT * FROM submissions WHERE id = $1 AND student_id = $2', [req.params.submissionId, req.user.id]);
    if (subRes.rows.length === 0) {
      return res.status(404).json({ error: { code: 'ATTEMPT_NOT_FOUND', message: 'Attempt not found.' } });
    }

    const sub = subRes.rows[0];
    if (sub.attempt_status !== 'in_progress' || sub.submitted_at) {
      return attemptLimitError(res);
    }
    // F-09: the server owns the clock. Answers sent after the deadline are discarded.
    if (isAttemptExpired(sub)) {
      return sendAttemptExpired(res, await finalizeExpiredAttempt(query, sub));
    }
    const questions = sub.question_snapshot || [];
    const storedResponses = sub.responses || [];
    const incoming = Array.isArray(req.body?.responses) ? req.body.responses : storedResponses;

    const grade = gradeResponses(questions, incoming);
    const { status: gradingStatus, score: gradingScore } = classifyGrading(questions, grade, grade.answered > 0);

    // Compute graded_at in JS and use each parameter exactly once with an explicit cast.
    // Reusing $2 in both an assignment and a CASE comparison made Postgres fail with
    // "inconsistent types deduced for parameter $2" (F-01).
    const gradedAt = gradingStatus === 'auto_graded' ? new Date() : null;
    const result = await query(
      `UPDATE submissions
       SET responses = $1::jsonb, attempt_status = 'submitted', submitted_at = now(),
           grading_status = $2::text, grading_score = $3::numeric,
           graded_at = COALESCE($4::timestamptz, graded_at), updated_at = now()
       WHERE id = $5 AND student_id = $6 AND attempt_status = 'in_progress' AND submitted_at IS NULL
       RETURNING *`,
      [JSON.stringify(incoming), gradingStatus, gradingScore, gradedAt, sub.id, req.user.id]
    );

    if (result.rows.length === 0) {
      return attemptLimitError(res);
    }

    res.json({
      success: true,
      submission: publicSubmission(result.rows[0]),
      score: gradingScore,
      maxScore: grade.possible
    });
  } catch (err) {
    next(err);
  }
});

// Auto-grade a set of responses against an assessment's questions.
// Only machine-gradable questions can earn points. A question with several correct options is
// worth full points only when the selected set equals the answer key (no credit for one pick of two).
function gradeResponses(questions, responses) {
  const qs = Array.isArray(questions) ? questions : [];
  const rs = Array.isArray(responses) ? responses : [];
  if (qs.length === 0) return { percentage: null, earned: 0, possible: 0, answered: rs.length };

  let earned = 0;
  let possible = 0;
  let answered = 0;
  for (const q of qs) {
    const pts = Number(q.points || 1);
    possible += pts;
    const resp = rs.find((r) => (r.questionId || r.id) === q.id);
    if (!resp) continue;
    const value = resp.value !== undefined ? resp.value : resp.answer;
    const selected = normalizeAnswerSet(value);
    if (selected.size === 0) continue;
    answered += 1;
    if (!isAutoGradableQuestion(q)) continue;
    const key = answerKey(q);
    if (selected.size === key.size && [...selected].every((v) => key.has(v))) earned += pts;
  }

  return {
    percentage: possible > 0 ? Math.round((earned / possible) * 100) : 0,
    earned,
    possible,
    answered
  };
}

// POST /assessments/:id/submit
router.post('/assessments/:id/submit', authenticate, assignmentUpload.array('files', 10), async (req, res, next) => {
  try {
    const { submissionId, answers, responses, files } = req.body || {};
    const rawProvided = responses ?? answers ?? [];

    const assessRes = await query('SELECT * FROM assessments WHERE id = $1', [req.params.id]);
    if (assessRes.rows.length === 0) {
      return res.status(404).json({ error: { code: 'ASSESSMENT_NOT_FOUND', message: 'Assessment not found.' } });
    }
    const a = assessRes.rows[0];
    const questions = typeof a.questions === 'string' ? JSON.parse(a.questions) : (a.questions || []);
    const provided = normalizeAssessmentResponses(questions, rawProvided);
    const uploadedFiles = req.files || [];

    // F-04: same publication + enrollment rules as the start flow; never trust client course/role.
    const isStaff = req.user.role === 'admin' || req.user.role === 'instructor';
    if (!isStaff && a.status !== 'published') {
      return res.status(404).json({ error: { code: 'ASSESSMENT_NOT_FOUND', message: 'Assessment not found.' } });
    }
    if (!isStaff && a.course_id) {
      const enr = await query(
        "SELECT 1 FROM enrollments WHERE student_id = $1 AND course_id = $2 AND status IN ('enrolled','completed')",
        [req.user.id, a.course_id]
      );
      if (enr.rows.length === 0) {
        return res.status(403).json({ error: { code: 'ENROLLMENT_REQUIRED', message: 'Enroll in this course before submitting.' } });
      }
    }

    if (['assignment', 'task'].includes(a.type) && uploadedFiles.length === 0) {
      return res.status(400).json({ error: { code: 'FILE_REQUIRED', message: 'Upload at least one assignment file before submitting.' } });
    }
    if (uploadedFiles.length && !['assignment', 'task'].includes(a.type)) {
      return res.status(400).json({ error: { code: 'FILES_NOT_ALLOWED', message: 'Files can only be submitted for assignments and tasks.' } });
    }

    // F-09: a student who already started this assessment is completing THAT attempt (so its
    // deadline applies), even if the client did not send the submission id.
    let effectiveSubmissionId = submissionId;
    if (!effectiveSubmissionId && !isStaff) {
      const open = await query(
        "SELECT id FROM submissions WHERE student_id = $1 AND assessment_id = $2 AND attempt_status = 'in_progress' ORDER BY created_at DESC LIMIT 1",
        [req.user.id, a.id]
      );
      if (open.rows.length) effectiveSubmissionId = String(open.rows[0].id);
    }
    // Timed quizzes/exams (not assignments, which may be handed in late and are flagged as late)
    // must respect the availability window even without a server-side attempt.
    if (!isStaff && !effectiveSubmissionId && !['assignment', 'task'].includes(a.type)) {
      const nowD = new Date();
      if (a.available_from && nowD < new Date(a.available_from)) {
        return res.status(409).json({ error: { code: 'ASSESSMENT_NOT_YET_AVAILABLE', message: 'Assessment is not yet available.' } });
      }
      if (a.due_at && nowD > new Date(a.due_at)) {
        return res.status(409).json({ error: { code: 'ASSESSMENT_PAST_DUE', message: 'The deadline for this assessment has passed.' } });
      }
      if (REQUIRE_ATTEMPT_FOR_TIMED) {
        return res.status(409).json({ error: { code: 'ATTEMPT_REQUIRED', message: 'Start the assessment before submitting it.' } });
      }
    }

    if (effectiveSubmissionId) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const attemptCount = await lockStudentAssessmentAttempt(client, req.user.id, a.id);
        const subRes = await client.query(
          'SELECT * FROM submissions WHERE id = $1 AND student_id = $2 AND assessment_id = $3 FOR UPDATE',
          [effectiveSubmissionId, req.user.id, a.id]
        );
        if (subRes.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: { code: 'ATTEMPT_NOT_FOUND', message: 'Attempt not found.' } });
        }
        const sub = subRes.rows[0];
        if (attemptCount !== 1 || sub.attempt_status !== 'in_progress' || sub.submitted_at) {
          await client.query('ROLLBACK');
          return attemptLimitError(res);
        }
        if (isAttemptExpired(sub)) {
          const fin = await finalizeExpiredAttempt((t, p) => client.query(t, p), sub);
          await client.query('COMMIT');
          return sendAttemptExpired(res, fin);
        }
        const snapshot = sub.question_snapshot || questions;
        const merged = Array.isArray(provided) && provided.length ? provided : (sub.responses || []);
        const grade = gradeResponses(snapshot, merged);
        const cls = classifyGrading(snapshot, grade, grade.answered > 0 || uploadedFiles.length > 0);
        const result = await client.query(
          `UPDATE submissions
           SET responses = $1::jsonb, attempt_status = 'submitted', submitted_at = now(),
               grading_status = $2::text, grading_score = $3::numeric,
               graded_at = COALESCE($4::timestamptz, graded_at), updated_at = now()
           WHERE id = $5 AND attempt_status = 'in_progress' AND submitted_at IS NULL
           RETURNING *`,
          [JSON.stringify(merged), cls.status, cls.score, cls.status === 'auto_graded' ? new Date() : null, sub.id]
        );
        if (result.rows.length === 0) {
          await client.query('ROLLBACK');
          return attemptLimitError(res);
        }
        for (const file of uploadedFiles) {
          await client.query(
            `INSERT INTO assessment_submission_files (submission_id, original_name, mime_type, file_size, file_data)
             VALUES ($1, $2, $3, $4, $5)`,
            [sub.id, file.originalname, file.mimetype, file.size, file.buffer]
          );
        }
        await client.query('COMMIT');
        return res.json({ success: true, submission: publicSubmission(result.rows[0]), score: cls.score });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }

    // Direct submit: grade against the stored answer key. No answers => no score.
    const grade = gradeResponses(questions, provided);
    const hasContent = grade.answered > 0 || uploadedFiles.length > 0;
    const { status: gradingStatus, score: gradingScore } = classifyGrading(questions, grade, hasContent);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const attemptCount = await lockStudentAssessmentAttempt(client, req.user.id, a.id);
      const maxAttempts = Number(a.max_attempts || 1);
      if (attemptCount >= maxAttempts) {
        await client.query('ROLLBACK');
        return attemptLimitError(res);
      }
      const result = await client.query(
        `INSERT INTO submissions (student_id, course_id, assessment_id, kind, submission_type, responses, attempt_status, grading_status, grading_score, submitted_at, graded_at)
         VALUES ($1, $2, $3, 'assessment', $4, $5, 'submitted', $6, $7, now(), $8)
         RETURNING *`,
        [req.user.id, a.course_id, req.params.id, uploadedFiles.length ? 'essay' : 'mcq', JSON.stringify(provided), gradingStatus, gradingScore, gradingStatus === 'auto_graded' ? new Date() : null]
      );
      const submission = result.rows[0];
      for (const file of uploadedFiles) {
        await client.query(
          `INSERT INTO assessment_submission_files (submission_id, original_name, mime_type, file_size, file_data)
           VALUES ($1, $2, $3, $4, $5)`,
          [submission.id, file.originalname, file.mimetype, file.size, file.buffer]
        );
      }
      await client.query('COMMIT');
      res.json({ success: true, submission: publicSubmission(submission), score: gradingScore });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

// List assignment attachments and download their database-stored contents.
async function authorizeSubmissionFileAccess(req, res, next) {
  try {
    const result = await query(
      `SELECT s.student_id, a.author_id
       FROM submissions s LEFT JOIN assessments a ON a.id = s.assessment_id
       WHERE s.id = $1`,
      [req.params.submissionId]
    );
    if (!result.rows.length) return res.status(404).json({ error: { code: 'SUBMISSION_NOT_FOUND', message: 'Submission not found.' } });
    const { student_id: studentId } = result.rows[0];
    if (req.user.role !== 'admin' && String(req.user.id) !== String(studentId)) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You cannot access these submission files.' } });
    }
    next();
  } catch (err) {
    next(err);
  }
}

router.get('/attempts/:submissionId/files', authenticate, authorizeSubmissionFileAccess, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT id, original_name, mime_type, file_size, created_at
       FROM assessment_submission_files WHERE submission_id = $1 ORDER BY created_at, id`,
      [req.params.submissionId]
    );
    res.json(result.rows.map((file) => ({ ...file, id: String(file.id), downloadUrl: `/v1/attempts/${req.params.submissionId}/files/${file.id}` })));
  } catch (err) { next(err); }
});

router.get('/attempts/:submissionId/files/:fileId', authenticate, authorizeSubmissionFileAccess, async (req, res, next) => {
  try {
    const result = await query(
      'SELECT original_name, mime_type, file_data FROM assessment_submission_files WHERE id = $1 AND submission_id = $2',
      [req.params.fileId, req.params.submissionId]
    );
    if (!result.rows.length) return res.status(404).json({ error: { code: 'FILE_NOT_FOUND', message: 'Submission file not found.' } });
    const file = result.rows[0];
    // F-14: never trust the uploader-supplied MIME type. Only types that are inert in a browser
    // are shown inline (chosen by the file extension); everything else is a forced download.
    const SAFE_INLINE = { '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8' };
    const ext = (String(file.original_name || '').toLowerCase().match(/\.[^.]+$/) || [''])[0];
    const inlineType = SAFE_INLINE[ext];
    res.set('Content-Type', inlineType || 'application/octet-stream');
    res.set('Content-Disposition', `${inlineType ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.original_name)}`);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'private, no-store');
    res.send(file.file_data);
  } catch (err) { next(err); }
});

router.get('/attempts/:submissionId/review', authenticate, requireRoles('admin'), async (req, res, next) => {
  try {
    const result = await query(
      `SELECT s.id, s.student_id, u.name AS student_name, u.email AS student_email,
              s.assessment_id, a.author_id, a.title AS assessment_title, a.type AS assessment_type,
              a.due_at, a.questions AS assessment_questions,
              s.attempt_status, s.submitted_at, s.grading_status, s.grading_score,
              s.grading_feedback, s.grading_comments, s.grading_suggestions,
              s.responses, s.question_snapshot, s.started_at,
              COALESCE(files.items, '[]'::jsonb) AS files
       FROM submissions s
       JOIN users u ON u.id = s.student_id
       LEFT JOIN assessments a ON a.id = s.assessment_id
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(jsonb_build_object(
           'id', f.id, 'originalName', f.original_name, 'mimeType', f.mime_type, 'fileSize', f.file_size
         ) ORDER BY f.created_at, f.id) AS items
         FROM assessment_submission_files f WHERE f.submission_id = s.id
       ) files ON true
       WHERE s.id = $1`,
      [req.params.submissionId]
    );
    if (!result.rows.length) return res.status(404).json({ error: { code: 'SUBMISSION_NOT_FOUND', message: 'Submission not found.' } });
    const row = result.rows[0];
    if (req.user.role !== 'admin' && String(req.user.id) !== String(row.author_id)) {
      const author = await query('SELECT author_id FROM assessments WHERE id = $1', [row.assessment_id]);
      if (!author.rows.length || String(req.user.id) !== String(author.rows[0].author_id)) {
        return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You cannot grade this submission.' } });
      }
    }
    res.json({
      id: String(row.id),
      studentId: String(row.student_id),
      studentName: row.student_name,
      studentEmail: row.student_email,
      assessmentId: String(row.assessment_id),
      assessmentTitle: row.assessment_title,
      assessmentType: row.assessment_type,
      dueAt: row.due_at,
      assessmentQuestions: row.assessment_questions || [],
      attemptStatus: row.attempt_status,
      submittedAt: row.submitted_at,
      gradingStatus: row.grading_status,
      score: row.grading_score === null ? null : Number(row.grading_score),
      feedback: row.grading_feedback,
      comments: row.grading_comments,
      suggestions: row.grading_suggestions,
      responses: row.responses || [],
      questionSnapshot: row.question_snapshot || [],
      startedAt: row.started_at,
      late: Boolean(row.due_at && row.submitted_at && new Date(row.submitted_at) > new Date(row.due_at)),
      files: (row.files || []).map((file) => ({ ...file, id: String(file.id) }))
    });
  } catch (err) { next(err); }
});

// GET /assessments/:id/submissions
router.get('/assessments/:id/submissions', authenticate, requireRoles('admin'), async (req, res, next) => {
  try {
    const result = await query(
      `SELECT s.id, u.id AS student_id, u.name AS student_name, u.email AS student_email,
              s.attempt_status, s.grading_status, s.grading_score AS score,
              s.submitted_at AS submitted_at, s.started_at, s.grading_feedback,
              CASE
                WHEN s.id IS NULL THEN CASE WHEN active_attempt.id IS NULL THEN 'not_submitted' ELSE 'in_progress' END
                WHEN s.attempt_status = 'in_progress' THEN 'in_progress'
                WHEN a.due_at IS NOT NULL AND s.submitted_at > a.due_at THEN 'late'
                WHEN s.grading_status = 'graded' THEN 'graded'
                ELSE 'submitted'
              END AS status,
              COALESCE(files.items, '[]'::jsonb) AS files
       FROM assessments a
       JOIN users u ON u.role = 'student' AND u.deleted_at IS NULL
       LEFT JOIN enrollments e ON e.student_id = u.id
         AND e.status IN ('enrolled', 'completed')
         AND a.course_id IS NOT NULL AND e.course_id = a.course_id
       LEFT JOIN LATERAL (
         SELECT attempt.* FROM submissions attempt
         WHERE attempt.assessment_id = a.id AND attempt.student_id = u.id
         ORDER BY attempt.attempt_number DESC, attempt.created_at DESC LIMIT 1
       ) s ON true
       LEFT JOIN LATERAL (
         SELECT attempt.id FROM submissions attempt
         WHERE attempt.assessment_id = a.id AND attempt.student_id = u.id AND attempt.attempt_status = 'in_progress'
         ORDER BY attempt.created_at DESC LIMIT 1
       ) active_attempt ON true
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(jsonb_build_object(
           'id', f.id, 'originalName', f.original_name, 'mimeType', f.mime_type, 'fileSize', f.file_size
         ) ORDER BY f.created_at, f.id) AS items
         FROM assessment_submission_files f WHERE f.submission_id = s.id
       ) files ON true
       WHERE a.id = $1 AND (a.course_id IS NULL OR e.id IS NOT NULL)
       ORDER BY u.name`,
      [req.params.id]
    );
    res.json(result.rows.map((row) => ({
      ...row,
      id: row.id ? String(row.id) : `student-${row.student_id}`,
      student_id: String(row.student_id),
      studentName: row.student_name,
      studentEmail: row.student_email,
      grading_status: row.grading_status || null,
      score: row.score === null ? null : Number(row.score),
      submittedAt: row.submitted_at,
      files: (row.files || []).map((file) => ({ ...file, id: String(file.id) }))
    })));
  } catch (err) {
    next(err);
  }
});

// GET /courses/:courseId/grading-queue
router.get('/courses/:courseId/grading-queue', authenticate, requireRoles('admin'), async (req, res, next) => {
  try {
    const result = await query(
      `SELECT s.*, u.name as student_name, a.title as assessment_title
       FROM submissions s
       JOIN users u ON u.id = s.student_id
       LEFT JOIN assessments a ON a.id = s.assessment_id
       WHERE s.course_id = $1 AND s.attempt_status = 'submitted'
       ORDER BY s.submitted_at ASC`,
      [req.params.courseId]
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// PATCH /attempts/:submissionId/grade
router.patch('/attempts/:submissionId/grade', authenticate, requireRoles('admin'), async (req, res, next) => {
  try {
    const { score, feedback, comments, suggestions } = req.body || {};
    const result = await query(
      `UPDATE submissions
       SET grading_score = $1, grading_feedback = $2, grading_comments = $3,
           grading_suggestions = $4, grading_status = 'graded',
           graded_by = $5, graded_at = now(), updated_at = now()
       WHERE id = $6
       RETURNING *`,
      [score, feedback || null, comments || null, suggestions || null, req.user.id, req.params.submissionId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: { code: 'SUBMISSION_NOT_FOUND', message: 'Submission not found.' } });
    }

    const sub = result.rows[0];
    const dedupKey = `submission_graded:${sub.id}`;
    await query(
      `INSERT INTO notifications (recipient_id, type, payload, deduplication_key)
       VALUES ($1, 'assessment_graded', $2, $3)
       ON CONFLICT (recipient_id, deduplication_key) WHERE deduplication_key IS NOT NULL
       DO NOTHING`,
      [
        sub.student_id,
        JSON.stringify({ submissionId: String(sub.id), assessmentId: String(sub.assessment_id), score: sub.grading_score }),
        dedupKey
      ]
    );

    res.json(sub);
  } catch (err) {
    next(err);
  }
});

export default router;
