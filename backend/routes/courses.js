import { Router } from 'express';
import { query } from '../db/pool.js';
import { authenticate, authenticateOptional, requireRoles } from '../middleware/auth.js';

const router = Router();

function formatCourse(c, lessons = [], userEnrollment = null, completedLessonIds = []) {
  const isEnrolled = !!userEnrollment && userEnrollment.status === 'enrolled';
  const totalLessons = lessons.length;
  const completedCount = completedLessonIds.length;
  const progress = totalLessons > 0 ? Math.round((completedCount / totalLessons) * 100) : 0;

  return {
    id: String(c.id),
    _id: String(c.id),
    project_id: String(c.id),
    title: c.title,
    description: c.description,
    subtitle: c.description.slice(0, 100),
    category: c.category || 'Development',
    difficulty: c.difficulty || 'beginner',
    level: c.difficulty || 'beginner',
    pricing: {
      access: c.pricing_access || 'free',
      currency: c.pricing_currency || null,
      amount: c.pricing_amount !== null ? Number(c.pricing_amount) : null
    },
    instructorId: String(c.instructor_id),
    instructor: c.instructor_name || 'Instructor',
    status: c.status,
    is_published: c.status === 'published',
    enrollmentOpen: c.enrollment_open,
    thumbnail: c.thumbnail || null,
    total_hours: Math.max(1, Math.round(totalLessons * 1.5)),
    lessons: lessons.map((l) => ({
      id: String(l.id),
      _id: String(l.id),
      title: l.title,
      content: l.content,
      position: l.position,
      status: l.status,
      duration: '15 mins',
      isCompleted: completedLessonIds.includes(String(l.id))
    })),
    modules: [
      {
        id: 'mod-1',
        title: 'Course Content',
        lessons: lessons.map((l) => ({
          id: String(l.id),
          _id: String(l.id),
          title: l.title,
          type: 'video',
          duration: '15 mins',
          is_preview: l.position === 1,
          isCompleted: completedLessonIds.includes(String(l.id))
        }))
      }
    ],
    enrolled: isEnrolled,
    isEnrolled,
    progress,
    publishedAt: c.published_at,
    createdAt: c.created_at,
    updatedAt: c.updated_at
  };
}

// GET /categories
router.get('/categories', (_req, res) => {
  res.json(['Getting Started', 'Development', 'Design', 'Data Science', 'AI & ML']);
});

// GET / and GET /catalog
async function listCourses(req, res, next) {
  try {
    const { category, difficulty, level, search, limit = 50 } = req.query;
    const diff = difficulty || level;

    let sql = `
      SELECT c.*, u.name as instructor_name,
             COALESCE(json_agg(l.* ORDER BY l.position) FILTER (WHERE l.id IS NOT NULL), '[]') as lessons
      FROM courses c
      LEFT JOIN users u ON u.id = c.instructor_id
      LEFT JOIN lessons l ON l.course_id = c.id
      WHERE c.status != 'archived'
    `;
    const params = [];

    if (category) {
      params.push(category);
      sql += ` AND c.category ILIKE $${params.length}`;
    }
    if (diff) {
      params.push(diff);
      sql += ` AND c.difficulty = $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      sql += ` AND (c.title ILIKE $${params.length} OR c.description ILIKE $${params.length})`;
    }

    sql += ` GROUP BY c.id, u.name ORDER BY c.published_at DESC NULLS LAST LIMIT $${params.length + 1}`;
    params.push(Math.min(100, Number(limit) || 50));

    const result = await query(sql, params);

    // Fetch student's enrollments & progress if logged in
    let userEnrollments = [];
    let completedLessons = [];
    if (req.user) {
      const enrRes = await query('SELECT * FROM enrollments WHERE student_id = $1', [req.user.id]);
      userEnrollments = enrRes.rows;
      const progRes = await query('SELECT lesson_id, course_id FROM lesson_progress WHERE user_id = $1', [req.user.id]);
      completedLessons = progRes.rows;
    }

    const formatted = result.rows.map((row) => {
      const enrollment = userEnrollments.find((e) => String(e.course_id) === String(row.id));
      const userCompleted = completedLessons.filter((p) => String(p.course_id) === String(row.id)).map((p) => String(p.lesson_id));
      return formatCourse(row, row.lessons || [], enrollment, userCompleted);
    });

    res.json(formatted);
  } catch (err) {
    next(err);
  }
}

router.get('/', authenticateOptional, listCourses);
router.get('/catalog', authenticateOptional, listCourses);

// GET /:id
router.get('/:id', authenticateOptional, async (req, res, next) => {
  try {
    const courseRes = await query(
      `SELECT c.*, u.name as instructor_name
       FROM courses c
       LEFT JOIN users u ON u.id = c.instructor_id
       WHERE c.id = $1`,
      [req.params.id]
    );

    if (courseRes.rows.length === 0) {
      return res.status(404).json({ error: { code: 'COURSE_NOT_FOUND', message: 'Course not found.' } });
    }

    const course = courseRes.rows[0];
    const lessonsRes = await query(
      'SELECT * FROM lessons WHERE course_id = $1 ORDER BY position ASC',
      [course.id]
    );

    let userEnrollment = null;
    let completedLessonIds = [];
    if (req.user) {
      const enrRes = await query('SELECT * FROM enrollments WHERE student_id = $1 AND course_id = $2', [req.user.id, course.id]);
      userEnrollment = enrRes.rows[0] || null;
      const progRes = await query('SELECT lesson_id FROM lesson_progress WHERE user_id = $1 AND course_id = $2', [req.user.id, course.id]);
      completedLessonIds = progRes.rows.map((p) => String(p.lesson_id));
    }

    res.json(formatCourse(course, lessonsRes.rows, userEnrollment, completedLessonIds));
  } catch (err) {
    next(err);
  }
});

// POST / (create course)
router.post('/', authenticate, requireRoles('admin'), async (req, res, next) => {
  try {
    const { title, description, category, difficulty, pricing, status = 'draft', enrollmentOpen = true } = req.body || {};
    if (!title || !description) {
      return res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Title and description are required.' } });
    }

    const pricingAccess = pricing?.access || 'free';
    const pricingCurrency = pricing?.currency || null;
    const pricingAmount = pricing?.amount !== undefined ? pricing.amount : null;

    const result = await query(
      `INSERT INTO courses (title, description, category, difficulty, pricing_access, pricing_currency, pricing_amount, instructor_id, status, enrollment_open, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        title.trim(),
        description.trim(),
        category || 'Development',
        difficulty || 'beginner',
        pricingAccess,
        pricingCurrency,
        pricingAmount,
        req.user.id,
        status,
        enrollmentOpen,
        status === 'published' ? new Date() : null
      ]
    );

    const created = result.rows[0];
    res.status(201).json(formatCourse(created, []));
  } catch (err) {
    next(err);
  }
});

// PATCH /:id and PUT /:id (update course)
async function updateCourseHandler(req, res, next) {
  try {
    const { title, description, category, difficulty, pricing, status, enrollmentOpen } = req.body || {};

    const existingRes = await query('SELECT * FROM courses WHERE id = $1', [req.params.id]);
    if (existingRes.rows.length === 0) {
      return res.status(404).json({ error: { code: 'COURSE_NOT_FOUND', message: 'Course not found.' } });
    }

    const c = existingRes.rows[0];
    if (req.user.role !== 'admin' && String(c.instructor_id) !== String(req.user.id)) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You do not have permission to edit this course.' } });
    }

    const newTitle = title !== undefined ? title.trim() : c.title;
    const newDesc = description !== undefined ? description.trim() : c.description;
    const newCategory = category !== undefined ? category : c.category;
    const newDifficulty = difficulty !== undefined ? difficulty : c.difficulty;
    const newPricingAccess = pricing?.access !== undefined ? pricing.access : c.pricing_access;
    const newPricingCurrency = pricing?.currency !== undefined ? pricing.currency : c.pricing_currency;
    const newPricingAmount = pricing?.amount !== undefined ? pricing.amount : c.pricing_amount;
    const newStatus = status !== undefined ? status : c.status;
    const newEnrollmentOpen = enrollmentOpen !== undefined ? enrollmentOpen : c.enrollment_open;
    const publishedAt = newStatus === 'published' && !c.published_at ? new Date() : c.published_at;

    const result = await query(
      `UPDATE courses
       SET title = $1, description = $2, category = $3, difficulty = $4,
           pricing_access = $5, pricing_currency = $6, pricing_amount = $7,
           status = $8, enrollment_open = $9, published_at = $10, updated_at = now()
       WHERE id = $11
       RETURNING *`,
      [newTitle, newDesc, newCategory, newDifficulty, newPricingAccess, newPricingCurrency, newPricingAmount, newStatus, newEnrollmentOpen, publishedAt, req.params.id]
    );

    const lessonsRes = await query('SELECT * FROM lessons WHERE course_id = $1 ORDER BY position ASC', [req.params.id]);
    res.json(formatCourse(result.rows[0], lessonsRes.rows));
  } catch (err) {
    next(err);
  }
}

router.patch('/:id', authenticate, requireRoles('admin'), updateCourseHandler);
router.put('/:id', authenticate, requireRoles('admin'), updateCourseHandler);

// DELETE /:id (archive course)
router.delete('/:id', authenticate, requireRoles('admin'), async (req, res, next) => {
  try {
    const existingRes = await query('SELECT * FROM courses WHERE id = $1', [req.params.id]);
    if (existingRes.rows.length === 0) {
      return res.status(404).json({ error: { code: 'COURSE_NOT_FOUND', message: 'Course not found.' } });
    }

    const c = existingRes.rows[0];
    if (req.user.role !== 'admin' && String(c.instructor_id) !== String(req.user.id)) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You do not have permission to delete this course.' } });
    }

    await query("UPDATE courses SET status = 'archived', archived_at = now() WHERE id = $1", [req.params.id]);
    res.json({ success: true, message: 'Course archived.' });
  } catch (err) {
    next(err);
  }
});

// POST /:courseId/enroll (student self-enrollment)
router.post('/:courseId/enroll', authenticate, async (req, res, next) => {
  try {
    const courseRes = await query('SELECT id, status, enrollment_open FROM courses WHERE id = $1', [req.params.courseId]);
    if (courseRes.rows.length === 0) {
      return res.status(404).json({ error: { code: 'COURSE_NOT_FOUND', message: 'Course not found.' } });
    }

    const course = courseRes.rows[0];
    if (course.status !== 'published' || !course.enrollment_open) {
      return res.status(400).json({ error: { code: 'ENROLLMENT_CLOSED', message: 'This course is not accepting enrollments.' } });
    }

    const result = await query(
      `INSERT INTO enrollments (student_id, course_id, status, enrolled_at)
       VALUES ($1, $2, 'enrolled', now())
       ON CONFLICT (student_id, course_id) WHERE status = 'enrolled'
       DO UPDATE SET status = 'enrolled'
       RETURNING *`,
      [req.user.id, course.id]
    );

    res.status(201).json({
      success: true,
      enrollment: result.rows[0]
    });
  } catch (err) {
    next(err);
  }
});

// POST /:courseId/enroll/:id (admin enroll student)
router.post('/:courseId/enroll/:id', authenticate, requireRoles('admin'), async (req, res, next) => {
  try {
    const result = await query(
      `INSERT INTO enrollments (student_id, course_id, status, enrolled_at)
       VALUES ($1, $2, 'enrolled', now())
       ON CONFLICT (student_id, course_id) WHERE status = 'enrolled'
       DO UPDATE SET status = 'enrolled'
       RETURNING *`,
      [req.params.id, req.params.courseId]
    );
    res.status(201).json({ success: true, enrollment: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// DELETE /:courseId/enroll/:id (admin unenroll student)
router.delete('/:courseId/enroll/:id', authenticate, requireRoles('admin'), async (req, res, next) => {
  try {
    await query(
      `UPDATE enrollments SET status = 'dropped', dropped_at = now()
       WHERE student_id = $1 AND course_id = $2`,
      [req.params.id, req.params.courseId]
    );
    res.json({ success: true, message: 'Student unenrolled.' });
  } catch (err) {
    next(err);
  }
});

// Lessons Sub-routes
// POST /:courseId/lessons
router.post('/:courseId/lessons', authenticate, requireRoles('admin'), async (req, res, next) => {
  try {
    const { title, content, status = 'published' } = req.body || {};
    if (!title || !content) {
      return res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Title and content are required.' } });
    }

    const posRes = await query('SELECT COALESCE(MAX(position), 0) + 1 as next_pos FROM lessons WHERE course_id = $1', [req.params.courseId]);
    const nextPos = posRes.rows[0].next_pos;

    const result = await query(
      `INSERT INTO lessons (course_id, title, content, position, status, published_at)
       VALUES ($1, $2, $3, $4, $5, now())
       RETURNING *`,
      [req.params.courseId, title.trim(), content, nextPos, status]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// GET /:courseId/lessons/:lessonId
router.get('/:courseId/lessons/:lessonId', authenticateOptional, async (req, res, next) => {
  try {
    const result = await query('SELECT * FROM lessons WHERE id = $1 AND course_id = $2', [req.params.lessonId, req.params.courseId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: { code: 'LESSON_NOT_FOUND', message: 'Lesson not found.' } });
    }
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// PATCH /:courseId/lessons/:lessonId
router.patch('/:courseId/lessons/:lessonId', authenticate, requireRoles('admin'), async (req, res, next) => {
  try {
    const { title, content, status } = req.body || {};
    const existing = await query('SELECT * FROM lessons WHERE id = $1 AND course_id = $2', [req.params.lessonId, req.params.courseId]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: { code: 'LESSON_NOT_FOUND', message: 'Lesson not found.' } });
    }

    const l = existing.rows[0];
    const newTitle = title !== undefined ? title.trim() : l.title;
    const newContent = content !== undefined ? content : l.content;
    const newStatus = status !== undefined ? status : l.status;

    const result = await query(
      `UPDATE lessons
       SET title = $1, content = $2, status = $3, updated_at = now()
       WHERE id = $4
       RETURNING *`,
      [newTitle, newContent, newStatus, req.params.lessonId]
    );

    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /:courseId/lessons/:lessonId
router.delete('/:courseId/lessons/:lessonId', authenticate, requireRoles('admin'), async (req, res, next) => {
  try {
    await query('DELETE FROM lessons WHERE id = $1 AND course_id = $2', [req.params.lessonId, req.params.courseId]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
