import { Router } from 'express';
import { query } from '../db/pool.js';
import { authenticate, requireRoles, allowAnonymous } from '../middleware/auth.js';

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /health and GET /admin/health (checks DB connectivity)
async function healthHandler(_req, res) {
  try {
    const dbRes = await query('SELECT 1 + 1 as ping');
    if (dbRes.rows.length > 0) {
      return res.status(200).json({
        status: 'ok',
        server: 'healthy',
        database: 'connected',
        timestamp: new Date().toISOString()
      });
    }
    throw new Error('Database ping returned empty');
  } catch (err) {
    return res.status(503).json({
      status: 'error',
      server: 'healthy',
      database: 'unreachable',
      error: err.message,
      timestamp: new Date().toISOString()
    });
  }
}

router.get('/health', allowAnonymous, healthHandler);
router.get('/admin/health', allowAnonymous, healthHandler);

// Guidelines CRUD
function formatGuideline(g) {
  return {
    id: String(g.id),
    _id: String(g.id),
    task_id: String(g.id),
    task_type: g.task_type || (g.scope === 'course' ? 'Course Specific Directive' : 'Global Directive'),
    description: g.content,
    directive: g.content,
    content: g.content,
    course: g.course_id ? String(g.course_id) : 'Global',
    project_id: g.course_id ? String(g.course_id) : 'Global',
    scope: g.scope,
    priority: g.priority || 'Normal',
    status: g.status,
    is_active: g.is_active !== undefined ? g.is_active : g.status === 'active',
    version: g.version,
    created_at: g.created_at,
    activatedAt: g.activated_at,
    updatedAt: g.updated_at
  };
}

// GET /admin/guidelines and GET /guidelines
async function listGuidelines(_req, res, next) {
  try {
    const result = await query('SELECT * FROM ai_guidelines WHERE status != \'archived\' ORDER BY created_at DESC');
    res.json(result.rows.map(formatGuideline));
  } catch (err) {
    next(err);
  }
}
router.get('/admin/guidelines', authenticate, listGuidelines);
router.get('/guidelines', authenticate, listGuidelines);

// POST /admin/guidelines and POST /guidelines
async function createGuideline(req, res, next) {
  try {
    const body = req.body || {};
    const { directive, description, content, scope, courseId, course, task_type, taskType, priority, status, is_active, isActive } = body;
    const text = directive || description || content;
    if (!text || !String(text).trim()) {
      return res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Guideline directive/content is required.' } });
    }

    // Only a real UUID targets a course. Labels like "Global"/"General" mean global scope.
    const rawCourse = courseId || course;
    const targetCourse = UUID_RE.test(String(rawCourse || '')) ? String(rawCourse) : null;
    const targetScope = targetCourse ? 'course' : (scope === 'course' && !targetCourse ? 'global' : (scope || 'global'));

    const resolvedStatus = ['draft', 'active', 'archived'].includes(status) ? status : 'active';
    const resolvedActive = is_active !== undefined ? !!is_active : isActive !== undefined ? !!isActive : resolvedStatus === 'active';
    const resolvedTaskType = task_type || taskType || (targetCourse ? 'Course Specific Directive' : 'Global Directive');
    const resolvedPriority = ['Low', 'Normal', 'High', 'Critical'].includes(priority) ? priority : 'Normal';

    const result = await query(
      `INSERT INTO ai_guidelines (scope, course_id, content, task_type, priority, status, is_active, created_by, activated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        targetScope,
        targetCourse,
        String(text).trim(),
        resolvedTaskType,
        resolvedPriority,
        resolvedStatus,
        resolvedActive,
        req.user.id,
        resolvedStatus === 'active' ? new Date() : null
      ]
    );

    res.status(201).json(formatGuideline(result.rows[0]));
  } catch (err) {
    next(err);
  }
}
router.post('/admin/guidelines', authenticate, requireRoles('admin'), createGuideline);
router.post('/guidelines', authenticate, requireRoles('admin'), createGuideline);

// PUT /admin/guidelines/:id/toggle
router.put('/admin/guidelines/:id/toggle', authenticate, requireRoles('admin'), async (req, res, next) => {
  try {
    const existing = await query('SELECT status FROM ai_guidelines WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Guideline not found.' } });
    }

    const currentStatus = existing.rows[0].status;
    const nextStatus = currentStatus === 'active' ? 'draft' : 'active';

    const result = await query(
      `UPDATE ai_guidelines
       SET status = $1, is_active = ($1 = 'active'),
           activated_at = CASE WHEN $2 = 'active' THEN now() ELSE activated_at END, updated_at = now()
       WHERE id = $3
       RETURNING *`,
      [nextStatus, nextStatus, req.params.id]
    );

    res.json(formatGuideline(result.rows[0]));
  } catch (err) {
    next(err);
  }
});

// DELETE /admin/guidelines/:id
router.delete('/admin/guidelines/:id', authenticate, requireRoles('admin'), async (req, res, next) => {
  try {
    await query('DELETE FROM ai_guidelines WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'Guideline deleted.' });
  } catch (err) {
    next(err);
  }
});

// System settings (DEF-09): persisted server-side so the Settings screen has a real effect.
function formatSettings(s) {
  return {
    academyName: s.academy_name,
    supportEmail: s.support_email,
    language: s.language,
    aiEnabled: s.ai_enabled,
    aiModel: s.ai_model,
    aiPersonality: s.ai_personality,
    maintenanceMode: s.maintenance_mode,
    restrictEnrollment: s.restrict_enrollment,
    twoFactorAuth: s.two_factor_auth,
    stripeKey: s.stripe_key || '',
    zoomClient: s.zoom_client || '',
    updatedAt: s.updated_at
  };
}

async function getSettingsRow() {
  const result = await query('SELECT * FROM system_settings WHERE singleton_key = true LIMIT 1');
  if (result.rows.length === 0) {
    const created = await query('INSERT INTO system_settings (singleton_key) VALUES (true) RETURNING *');
    return created.rows[0];
  }
  return result.rows[0];
}

router.get('/admin/settings', authenticate, requireRoles('admin'), async (_req, res, next) => {
  try {
    res.json(formatSettings(await getSettingsRow()));
  } catch (err) {
    next(err);
  }
});

router.put('/admin/settings', authenticate, requireRoles('admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const cur = await getSettingsRow();
    const academyName = b.academyName !== undefined ? String(b.academyName).trim() : cur.academy_name;
    if (b.academyName !== undefined && !academyName) {
      return res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Academy name cannot be empty.' } });
    }
    const supportEmail = b.supportEmail !== undefined ? String(b.supportEmail).trim() : cur.support_email;
    if (supportEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(supportEmail)) {
      return res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Support email is not valid.' } });
    }

    const result = await query(
      `UPDATE system_settings SET
         academy_name = $1, support_email = $2, language = $3, ai_enabled = $4,
         ai_model = $5, ai_personality = $6, maintenance_mode = $7, restrict_enrollment = $8,
         two_factor_auth = $9, stripe_key = $10, zoom_client = $11, updated_by = $12, updated_at = now()
       WHERE singleton_key = true
       RETURNING *`,
      [
        academyName,
        supportEmail,
        b.language !== undefined ? String(b.language) : cur.language,
        b.aiEnabled !== undefined ? !!b.aiEnabled : cur.ai_enabled,
        b.aiModel !== undefined ? String(b.aiModel) : cur.ai_model,
        b.aiPersonality !== undefined ? String(b.aiPersonality) : cur.ai_personality,
        b.maintenanceMode !== undefined ? !!b.maintenanceMode : cur.maintenance_mode,
        b.restrictEnrollment !== undefined ? !!b.restrictEnrollment : cur.restrict_enrollment,
        b.twoFactorAuth !== undefined ? !!b.twoFactorAuth : cur.two_factor_auth,
        b.stripeKey !== undefined ? String(b.stripeKey) : cur.stripe_key,
        b.zoomClient !== undefined ? String(b.zoomClient) : cur.zoom_client,
        req.user.id
      ]
    );
    res.json(formatSettings(result.rows[0]));
  } catch (err) {
    next(err);
  }
});

// GET /analytics/kpis
router.get('/analytics/kpis', authenticate, requireRoles('admin'), async (_req, res, next) => {  try {
    const [learnersRes, enrollRes, gradeRes, liveRes] = await Promise.all([
      query('SELECT COUNT(DISTINCT student_id) as count FROM enrollments WHERE status = \'enrolled\''),
      query('SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status = \'completed\') as completed FROM enrollments'),
      query(`SELECT COUNT(*) as taken, AVG(grading_score) as avg_score
             FROM submissions
             WHERE kind = 'assessment'
               AND grading_status IN ('auto_graded', 'graded')
               AND grading_score IS NOT NULL
               AND CASE WHEN jsonb_typeof(responses) = 'array'
                        THEN jsonb_array_length(responses) > 0
                        ELSE false END`),
      query('SELECT COUNT(*) as count FROM live_sessions')
    ]);

    const activeLearners = Number(learnersRes.rows[0]?.count || 0);
    const totalEnrollments = Number(enrollRes.rows[0]?.total || 0);
    const completedEnrollments = Number(enrollRes.rows[0]?.completed || 0);
    const completionRate = totalEnrollments > 0 ? Math.round((completedEnrollments / totalEnrollments) * 100) : 0;
    const quizzesTaken = Number(gradeRes.rows[0]?.taken || 0);
    const assessmentAvg = gradeRes.rows[0]?.avg_score !== null && gradeRes.rows[0]?.avg_score !== undefined
      ? Math.round(Number(gradeRes.rows[0].avg_score))
      : 0;
    const liveCount = Number(liveRes.rows[0]?.count || 0);

    res.json({
      activeLearners,
      completionRate,
      assessmentAvg,
      quizzesTaken,
      liveCount,
      totalSessions: liveCount,
      revenue: { notAvailable: true }
    });
  } catch (err) {
    next(err);
  }
});

export default router;
