import { Router } from 'express';
import { query } from '../db/pool.js';
import { authenticate, requireRoles } from '../middleware/auth.js';
import { notifyEventCreated } from '../services/calendarNotifications.js';

const router = Router();

function formatEvent(e) {
  return {
    id: String(e.id),
    _id: String(e.id),
    title: e.title,
    description: e.description || '',
    scope: e.scope,
    courseId: e.course_id ? String(e.course_id) : null,
    startsAt: e.starts_at,
    endsAt: e.ends_at,
    startDate: e.starts_at,
    endDate: e.ends_at,
    date: e.starts_at,
    type: e.event_type || 'custom',
    status: e.status,
    createdBy: e.created_by ? String(e.created_by) : null,
    createdAt: e.created_at,
    updatedAt: e.updated_at
  };
}

// GET /calendar and GET /events
async function listEvents(req, res, next) {
  try {
    const { from, to, month, year } = req.query;
    let sql = 'SELECT * FROM calendar_events WHERE status != \'cancelled\'';
    const params = [];

    if (from) {
      params.push(new Date(from));
      sql += ` AND starts_at >= $${params.length}`;
    }
    if (to) {
      params.push(new Date(to));
      sql += ` AND starts_at <= $${params.length}`;
    }

    sql += ' ORDER BY starts_at ASC';
    const result = await query(sql, params);

    // Also pull published assessment deadlines and scheduled live sessions into calendar
    const liveSessions = await query(
      'SELECT id, title, description, starts_at, ends_at, course_id FROM live_sessions WHERE status != \'cancelled\''
    );
    const assessments = await query(
      'SELECT id, title, instructions, due_at, course_id FROM assessments WHERE due_at IS NOT NULL AND status = \'published\''
    );

    const events = result.rows.map(formatEvent);

    for (const ls of liveSessions.rows) {
      events.push({
        id: `session-${ls.id}`,
        title: `Class: ${ls.title}`,
        description: ls.description || 'Live virtual classroom session',
        scope: 'course',
        courseId: String(ls.course_id),
        startsAt: ls.starts_at,
        endsAt: ls.ends_at,
        startDate: ls.starts_at,
        endDate: ls.ends_at,
        type: 'meeting',
        status: 'active'
      });
    }

    for (const a of assessments.rows) {
      events.push({
        id: `assessment-${a.id}`,
        title: `Due: ${a.title}`,
        description: a.instructions || 'Assessment submission deadline',
        scope: 'course',
        courseId: String(a.course_id),
        startsAt: a.due_at,
        endsAt: a.due_at,
        startDate: a.due_at,
        endDate: a.due_at,
        type: 'assessment',
        status: 'active'
      });
    }

    res.json(events);
  } catch (err) {
    next(err);
  }
}

router.get('/calendar', authenticate, listEvents);
router.get('/events', authenticate, listEvents);

// POST /calendar/events and POST /events
async function createEventHandler(req, res, next) {
  try {
    const body = req.body || {};
    const { title, description, scope = 'global', courseId, endsAt } = body;
    const eventType = scope === 'course' ? 'meeting' : 'custom';
    // Accept either an explicit startsAt or the client's { date, time } pair.
    let startsAt = body.startsAt || body.startDate || body.start;
    if (!startsAt && body.date) {
      startsAt = body.time ? `${body.date}T${body.time}` : body.date;
    }
    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Title is required.' } });
    }
    if (!startsAt) {
      return res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'A start date/time is required.' } });
    }
    if (!['global', 'course'].includes(scope)) {
      return res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Audience must be global or course.' } });
    }
    if (scope === 'course' && !courseId) {
      return res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Select a course for a course session.' } });
    }

    const start = new Date(startsAt);
    if (Number.isNaN(start.getTime())) {
      return res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'The start date/time could not be parsed.' } });
    }
    const end = endsAt ? new Date(endsAt) : new Date(start.getTime() + 60 * 60 * 1000);

    // The client posts to both /calendar/events and /events; guard against the
    // resulting duplicate by reusing an identical event created moments ago.
    const dupe = await query(
      `SELECT * FROM calendar_events
       WHERE created_by = $1 AND title = $2 AND starts_at = $3
         AND created_at > now() - interval '10 seconds'
       LIMIT 1`,
      [req.user.id, title.trim(), start]
    );
    if (dupe.rows.length > 0) {
      try {
        await notifyEventCreated(dupe.rows[0]);
      } catch (notificationError) {
        console.error('Could not create event notifications:', notificationError.message);
      }
      return res.status(200).json(formatEvent(dupe.rows[0]));
    }

    const result = await query(
      `INSERT INTO calendar_events (title, description, event_type, starts_at, ends_at, scope, course_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [title.trim(), description || '', eventType, start, end, scope, scope === 'course' ? courseId : null, req.user.id]
    );

    try {
      await notifyEventCreated(result.rows[0]);
    } catch (notificationError) {
      console.error('Could not create event notifications:', notificationError.message);
    }
    res.status(201).json(formatEvent(result.rows[0]));
  } catch (err) {
    next(err);
  }
}

router.post('/calendar/events', authenticate, requireRoles('admin'), createEventHandler);
router.post('/events', authenticate, requireRoles('admin'), createEventHandler);

// DELETE /events/:id
router.delete('/events/:id', authenticate, requireRoles('admin'), async (req, res, next) => {
  try {
    await query('DELETE FROM calendar_events WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'Event deleted.' });
  } catch (err) {
    next(err);
  }
});

export default router;
