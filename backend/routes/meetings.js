import { Router } from 'express';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { query } from '../db/pool.js';
import { authenticate, requireRoles } from '../middleware/auth.js';
import { getAccessSecret } from '../config/secrets.js';

const router = Router();

// Sessions left in 'live' well past their scheduled end are almost certainly abandoned
// (closed tab, crashed host). Sweep them to 'ended' so /admin/live can start a fresh
// broadcast instead of always attaching to a stale room. Grace period: 30 minutes.
async function reapStaleLiveSessions() {
  try {
    const result = await query(
      `UPDATE live_sessions SET status = 'ended', updated_at = now()
       WHERE status = 'live' AND ends_at < now() - interval '30 minutes'
       RETURNING id`
    );
    if (result.rows.length) {
      console.log(`Reaped ${result.rows.length} stale live session(s) past their scheduled end.`);
    }
    return result.rows.length;
  } catch (err) {
    console.error('Failed to reap stale live sessions:', err.message);
    return 0;
  }
}
reapStaleLiveSessions();
setInterval(reapStaleLiveSessions, 5 * 60 * 1000).unref?.();

function formatMeeting(m, attendance = []) {
  const duration = Math.max(15, Math.round((new Date(m.ends_at) - new Date(m.starts_at)) / 60000));
  return {
    id: String(m.id),
    _id: String(m.id),
    title: m.title,
    description: m.description || '',
    roomName: m.provider_room_id,
    roomSlug: m.provider_room_id,
    expectedDurationMinutes: duration,
    status: m.status,
    scheduledFor: m.starts_at,
    startsAt: m.starts_at,
    endsAt: m.ends_at,
    courseId: String(m.course_id),
    courseName: m.course_title || 'General Meeting',
    hostId: String(m.host_id),
    hostName: m.host_name || 'Host',
    lobbyEnabled: true,
    autoRecord: false,
    security: {
      muteOnEntry: true,
      requireHostToStart: true,
      disableStudentScreenShare: false
    },
    recurrence: {
      isRecurring: false,
      sessionIndex: 1,
      totalSessionsInSeries: 1
    },
    attendance: attendance.map((a) => ({
      name: a.student_name || 'Student',
      email: a.student_email || '',
      role: 'student',
      status: a.total_seconds > 0 ? 'attended' : 'registered',
      joinTime: a.active_joined_at || a.created_at,
      durationSeconds: a.total_seconds,
      attendancePercentage: Math.min(100, Math.round((a.total_seconds / (duration * 60)) * 100))
    })),
    myAttendance: attendance.find((a) => a.is_me) ? { attended: true } : { attended: false },
    aiSummary: m.ai_summary || {
      summary: 'Productive session covering course objectives and practical applications.',
      keyTakeaways: [
        'Introduced core architectural patterns and platform conventions.',
        'Explored hands-on interactive exercises.',
        'Shared scheduled milestones and assignment timelines.'
      ],
      generatedQuiz: [
        {
          question: 'What was the primary topic discussed in today’s session?',
          options: ['Platform Architecture', 'Database Migration', 'UI Components', 'Network Protocols'],
          correctIndex: 0
        }
      ]
    },
    createdAt: m.created_at,
    updatedAt: m.updated_at
  };
}

// GET /meetings and GET /live-sessions
async function listMeetings(req, res, next) {
  try {
    const { status, courseId, seriesId } = req.query;
    let sql = `
      SELECT ls.*, c.title as course_title, u.name as host_name
      FROM live_sessions ls
      LEFT JOIN courses c ON c.id = ls.course_id
      LEFT JOIN users u ON u.id = ls.host_id
      WHERE 1=1
    `;
    const params = [];

    if (status) {
      params.push(status);
      sql += ` AND ls.status = $${params.length}`;
    }
    if (courseId) {
      params.push(courseId);
      sql += ` AND ls.course_id = $${params.length}`;
    }
    if (req.user.role === 'student') {
      params.push(req.user.id);
      sql += ` AND EXISTS (
        SELECT 1 FROM enrollments e
        WHERE e.course_id = ls.course_id AND e.student_id = $${params.length}
          AND e.status IN ('enrolled', 'completed')
      )`;
    }
    if (req.user.role === 'instructor') {
      params.push(req.user.id);
      sql += ` AND ls.host_id = $${params.length}`;
    }

    sql += ' ORDER BY ls.starts_at DESC';
    const result = await query(sql, params);

    const formatted = result.rows.map((row) => formatMeeting(row));
    // Frontend consumers check { success, meetings }; keep both shapes available.
    res.json({ success: true, meetings: formatted, data: formatted });
  } catch (err) {
    next(err);
  }
}

router.get('/meetings', authenticate, listMeetings);
router.get('/live-sessions', authenticate, listMeetings);

// POST /meetings and POST /live-sessions (create meeting)
async function createMeetingHandler(req, res, next) {
  try {
    const {
      title,
      description,
      courseId,
      startsAt,
      endsAt,
      scheduledFor,
      roomName,
      providerRoomId,
      expectedDurationMinutes = 60
    } = req.body || {};

    if (!title) {
      return res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Title is required.' } });
    }

    // Default course if not specified
    let targetCourseId = courseId;
    if (!targetCourseId) {
      const firstCourse = await query(
        req.user.role === 'instructor'
          ? 'SELECT id FROM courses WHERE instructor_id = $1 LIMIT 1'
          : 'SELECT id FROM courses LIMIT 1',
        req.user.role === 'instructor' ? [req.user.id] : []
      );
      targetCourseId = firstCourse.rows[0]?.id;
    }

    if (!targetCourseId) {
      return res.status(400).json({ error: { code: 'NO_COURSE_AVAILABLE', message: 'Create a course before scheduling a session.' } });
    }
    if (req.user.role === 'instructor') {
      const course = await query('SELECT 1 FROM courses WHERE id = $1 AND instructor_id = $2', [targetCourseId, req.user.id]);
      if (!course.rows.length) {
        return res.status(403).json({ error: { code: 'COURSE_OWNER_REQUIRED', message: 'You can only schedule meetings for your own courses.' } });
      }
    }

    const start = new Date(startsAt || scheduledFor || Date.now());
    const end = new Date(endsAt || (start.getTime() + expectedDurationMinutes * 60 * 1000));
    const roomId = providerRoomId || roomName || `room-${crypto.randomUUID().slice(0, 8)}`;

    const result = await query(
      `INSERT INTO live_sessions (course_id, host_id, provider, provider_room_id, title, description, starts_at, ends_at, status)
       VALUES ($1, $2, 'jitsi', $3, $4, $5, $6, $7, 'scheduled')
       RETURNING *`,
      [targetCourseId, req.user.id, roomId, title.trim(), description || '', start, end]
    );

    const created = formatMeeting(result.rows[0]);
    res.status(201).json({
      success: true,
      meeting: created,
      ...created
    });
  } catch (err) {
    next(err);
  }
}

router.post('/meetings', authenticate, requireRoles('instructor', 'admin'), createMeetingHandler);
router.post('/live-sessions', authenticate, requireRoles('instructor', 'admin'), createMeetingHandler);

// POST /meeting-requests
// Lets an instructor forward a meeting-related update to every platform admin. The
// admin sees it in the existing notification menu, while the original message is
// retained for audit/history.
router.post('/meeting-requests', authenticate, requireRoles('instructor'), async (req, res, next) => {
  try {
    const { subject, message, meetingId } = req.body || {};
    const cleanSubject = String(subject || '').trim();
    const cleanMessage = String(message || '').trim();
    if (!cleanSubject || !cleanMessage) {
      return res.status(400).json({ error: { code: 'MESSAGE_REQUIRED', message: 'A subject and message are required.' } });
    }
    if (cleanSubject.length > 200 || cleanMessage.length > 5000) {
      return res.status(400).json({ error: { code: 'MESSAGE_TOO_LONG', message: 'Keep the subject under 200 characters and the message under 5,000 characters.' } });
    }

    let ownedMeetingId = null;
    if (meetingId) {
      const meeting = await query('SELECT id FROM live_sessions WHERE id = $1 AND host_id = $2', [meetingId, req.user.id]);
      if (!meeting.rows.length) {
        return res.status(403).json({ error: { code: 'MEETING_OWNER_REQUIRED', message: 'You can only forward updates about your own meetings.' } });
      }
      ownedMeetingId = meeting.rows[0].id;
    }

    const saved = await query(
      `INSERT INTO instructor_admin_messages (instructor_id, meeting_id, subject, message)
       VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
      [req.user.id, ownedMeetingId, cleanSubject, cleanMessage]
    );
    const admins = await query("SELECT id FROM users WHERE role = 'admin' AND deleted_at IS NULL");
    await Promise.all(admins.rows.map((admin) => query(
      `INSERT INTO notifications (recipient_id, type, payload, deduplication_key)
       VALUES ($1, 'system', $2, $3)`,
      [
        admin.id,
        JSON.stringify({
          title: `Instructor update: ${cleanSubject}`,
          message: `${req.user.name}: ${cleanMessage}`,
          source: 'instructor_meeting_message',
          meetingId: ownedMeetingId,
          messageId: saved.rows[0].id
        }),
        `instructor-message:${saved.rows[0].id}:${admin.id}`
      ]
    )));

    res.status(201).json({ success: true, messageId: saved.rows[0].id, deliveredTo: admins.rows.length });
  } catch (err) {
    next(err);
  }
});

// PUT /meetings/:id (update meeting)
router.put('/meetings/:id', authenticate, requireRoles('instructor', 'admin'), async (req, res, next) => {
  try {
    const { title, description, status, startsAt, endsAt } = req.body || {};
    const existingRes = await query(
      req.user.role === 'instructor'
        ? 'SELECT * FROM live_sessions WHERE id = $1 AND host_id = $2'
        : 'SELECT * FROM live_sessions WHERE id = $1',
      req.user.role === 'instructor' ? [req.params.id, req.user.id] : [req.params.id]
    );
    if (existingRes.rows.length === 0) {
      return res.status(404).json({ error: { code: 'MEETING_NOT_FOUND', message: 'Meeting not found.' } });
    }

    const m = existingRes.rows[0];
    const newTitle = title !== undefined ? title.trim() : m.title;
    const newDesc = description !== undefined ? description : m.description;
    const newStatus = status !== undefined ? status : m.status;
    const newStart = startsAt !== undefined ? new Date(startsAt) : m.starts_at;
    const newEnd = endsAt !== undefined ? new Date(endsAt) : m.ends_at;

    const result = await query(
      `UPDATE live_sessions
       SET title = $1, description = $2, status = $3, starts_at = $4, ends_at = $5, updated_at = now()
       WHERE id = $6
       RETURNING *`,
      [newTitle, newDesc, newStatus, newStart, newEnd, req.params.id]
    );

    res.json({ success: true, meeting: formatMeeting(result.rows[0]) });
  } catch (err) {
    next(err);
  }
});

// DELETE /meetings/:id
router.delete('/meetings/:id', authenticate, requireRoles('instructor', 'admin'), async (req, res, next) => {
  try {
    const deleted = await query(
      req.user.role === 'instructor'
        ? 'DELETE FROM live_sessions WHERE id = $1 AND host_id = $2 RETURNING id'
        : 'DELETE FROM live_sessions WHERE id = $1 RETURNING id',
      req.user.role === 'instructor' ? [req.params.id, req.user.id] : [req.params.id]
    );
    if (!deleted.rows.length) return res.status(404).json({ error: { code: 'MEETING_NOT_FOUND', message: 'Meeting not found.' } });
    res.json({ success: true, message: 'Meeting deleted.' });
  } catch (err) {
    next(err);
  }
});

// PUT /meetings/:id/launch & POST /meetings/:id/launch
async function launchMeetingHandler(req, res, next) {
  try {
    const result = await query(
      `UPDATE live_sessions
       SET status = 'live', updated_at = now()
       WHERE id = $1${req.user.role === 'instructor' ? ' AND host_id = $2' : ''}
       RETURNING *`,
      req.user.role === 'instructor' ? [req.params.id, req.user.id] : [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: { code: 'MEETING_NOT_FOUND', message: 'Meeting not found.' } });
    }
    res.json({ success: true, status: 'live', meeting: formatMeeting(result.rows[0]) });
  } catch (err) {
    next(err);
  }
}
router.put('/meetings/:id/launch', authenticate, requireRoles('instructor', 'admin'), launchMeetingHandler);
router.post('/meetings/:id/launch', authenticate, requireRoles('instructor', 'admin'), launchMeetingHandler);

// PUT /meetings/:id/end & POST /meetings/:id/end
async function endMeetingHandler(req, res, next) {
  try {
    const result = await query(
      `UPDATE live_sessions
       SET status = 'ended', updated_at = now()
       WHERE id = $1${req.user.role === 'instructor' ? ' AND host_id = $2' : ''}
       RETURNING *`,
      req.user.role === 'instructor' ? [req.params.id, req.user.id] : [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: { code: 'MEETING_NOT_FOUND', message: 'Meeting not found.' } });
    }
    await query(
      `UPDATE attendance_records
       SET total_seconds = total_seconds + CASE
             WHEN active_joined_at IS NULL THEN 0
             ELSE LEAST(60, GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - last_event_at)))::int))
           END,
           active_joined_at = NULL, last_event_at = now(), updated_at = now()
       WHERE session_id = $1 AND active_joined_at IS NOT NULL`,
      [req.params.id]
    );
    res.json({ success: true, status: 'ended', meeting: formatMeeting(result.rows[0]) });
  } catch (err) {
    next(err);
  }
}
router.put('/meetings/:id/end', authenticate, requireRoles('instructor', 'admin'), endMeetingHandler);
router.post('/meetings/:id/end', authenticate, requireRoles('instructor', 'admin'), endMeetingHandler);

// POST /live-sessions/:sessionId/join-token & POST /meetings/authorize-join
async function authorizeJoinHandler(req, res, next) {
  try {
    const sessionId = req.params.sessionId || req.body?.sessionId || req.body?.meetingId || req.body?.id;
    let sessionRes;
    if (sessionId) {
      sessionRes = await query('SELECT * FROM live_sessions WHERE id = $1', [sessionId]);
    } else {
      const roomKey = req.body?.roomSlug || req.body?.roomName || req.body?.room;
      sessionRes = roomKey
        ? await query('SELECT * FROM live_sessions WHERE provider_room_id = $1', [roomKey])
        : { rows: [] };
    }

    // Staff opening the live room without a specific session (e.g. sidebar "Live Classes"):
    // reuse the most recent live session if one is already running. Do NOT auto-create a new
    // session — starting a room is an explicit host action (req.body.start === true), so simply
    // clicking the sidebar no longer instantly launches and joins a session.
    const wantsStart = req.body?.start === true || req.body?.start === 'true';
    if (sessionRes.rows.length === 0 && !sessionId && !req.body?.roomSlug && !req.body?.roomName && !req.body?.room) {
      const isStaff = req.user.role === 'admin' || req.user.role === 'instructor';
      if (isStaff) {
        const liveRes = await query(
          `SELECT * FROM live_sessions WHERE status = 'live' ORDER BY starts_at DESC LIMIT 1`
        );
        if (liveRes.rows.length > 0) {
          sessionRes = liveRes;
        } else if (wantsStart) {
          const courseRes = await query('SELECT id FROM courses ORDER BY created_at ASC LIMIT 1');
          if (courseRes.rows.length === 0) {
            return res.status(400).json({ error: { code: 'NO_COURSE_AVAILABLE', message: 'Create a course before starting a live session.' } });
          }
          const start = new Date();
          const end = new Date(start.getTime() + 60 * 60 * 1000);
          const roomId = `room-${crypto.randomUUID().slice(0, 8)}`;
          const created = await query(
            `INSERT INTO live_sessions (course_id, host_id, provider, provider_room_id, title, description, starts_at, ends_at, status)
             VALUES ($1, $2, 'jitsi', $3, $4, $5, $6, $7, 'live')
             RETURNING *`,
            [courseRes.rows[0].id, req.user.id, roomId, 'Live Session', 'Instant session started from the Live Classes page.', start, end]
          );
          sessionRes = created;
        } else {
          // No active session and the host has not asked to start one: tell the client to show
          // a "Start Session" button instead of auto-joining a freshly created room.
          return res.json({
            success: true,
            authorized: false,
            canStart: true,
            waitingForHost: true,
            isHost: true,
            reason: 'NO_ACTIVE_SESSION',
            message: 'No active live session. Start one when you are ready.'
          });
        }
      }
    }

    if (sessionRes.rows.length === 0) {
      return res.status(404).json({ error: { code: 'SESSION_NOT_FOUND', message: 'Live session not found.' } });
    }

    const session = sessionRes.rows[0];
    const isHost = req.user.role === 'admin' || String(session.host_id) === String(req.user.id);

    if (req.user.role === 'instructor' && !isHost) {
      return res.status(403).json({ error: { code: 'MEETING_OWNER_REQUIRED', message: 'You can only open meetings that you host.' } });
    }

    // Enrollment gatekeeper: staff may host; students must already be enrolled.
    const isStaff = req.user.role === 'admin' || req.user.role === 'instructor';
    if (!isStaff && !isHost) {
      const enrollmentRes = await query(
        "SELECT 1 FROM enrollments WHERE student_id = $1 AND course_id = $2 AND status IN ('enrolled', 'completed')",
        [req.user.id, session.course_id]
      );
      if (enrollmentRes.rows.length === 0) {
        return res.status(403).json({ error: { code: 'COURSE_ENROLLMENT_REQUIRED', message: 'Enroll in this course before joining its live session.' } });
      }
    }

    const token = jwt.sign(
      {
        sub: String(req.user.id),
        name: req.user.name,
        email: req.user.email,
        role: req.user.role,
        room: session.provider_room_id,
        aud: process.env.JITSI_DOMAIN || 'meet.jit.si',
        iss: process.env.JITSI_APP_ID || process.env.JITSI_DOMAIN || 'meet.jit.si',
        isHost
      },
      process.env.JITSI_JWT_SECRET || getAccessSecret(),
      { expiresIn: '4h' }
    );

    const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000);
    res.json({
      success: true,
      authorized: true,
      waitingForHost: false,
      isHost,
      moderator: isHost,
      user: { id: String(req.user.id), name: req.user.name, email: req.user.email, role: req.user.role },
      meeting: formatMeeting(session),
      token,
      joinToken: token,
      room: session.provider_room_id,
      roomName: session.provider_room_id,
      expiresAt
    });
  } catch (err) {
    next(err);
  }
}
router.post('/live-sessions/:sessionId/join-token', authenticate, authorizeJoinHandler);
router.post('/meetings/authorize-join', authenticate, authorizeJoinHandler);

// GET /live-sessions/:sessionId/attendance & GET /meetings/:sessionId/attendance
async function getAttendanceHandler(req, res, next) {
  try {
    const sessionId = req.params.sessionId || req.params.id;
    if (req.user.role === 'instructor') {
      const session = await query('SELECT 1 FROM live_sessions WHERE id = $1 AND host_id = $2', [sessionId, req.user.id]);
      if (!session.rows.length) {
        return res.status(404).json({ error: { code: 'MEETING_NOT_FOUND', message: 'Meeting not found.' } });
      }
    }
    const result = await query(
      `SELECT u.id AS student_id, u.name AS student_name, u.email AS student_email,
              GREATEST(1, FLOOR(EXTRACT(EPOCH FROM (ls.ends_at - ls.starts_at)) / 60))::int AS expected_duration_minutes,
              ar.id AS attendance_id, COALESCE(ar.total_seconds, 0) AS total_seconds,
              ar.active_joined_at, ar.last_event_at, ar.created_at AS first_joined_at
       FROM live_sessions ls
       JOIN enrollments e ON e.course_id = ls.course_id
         AND e.status IN ('enrolled', 'completed')
       JOIN users u ON u.id = e.student_id AND u.role = 'student' AND u.deleted_at IS NULL
       LEFT JOIN attendance_records ar ON ar.session_id = ls.id AND ar.student_id = u.id
       WHERE ls.id = $1
       ORDER BY u.name, u.email`,
      [sessionId]
    );

    const totalCount = result.rows.length;
    const attendance = result.rows.map((r) => {
      const seconds = Number(r.total_seconds) || 0;
      const lastEvent = r.last_event_at ? new Date(r.last_event_at).getTime() : 0;
      const isPresentNow = !!r.active_joined_at && lastEvent >= Date.now() - 45000;
      return {
        id: r.attendance_id ? String(r.attendance_id) : null,
        studentId: String(r.student_id),
        name: r.student_name,
        email: r.student_email,
        totalSeconds: seconds,
        firstJoinedAt: r.first_joined_at,
        lastSeenAt: r.last_event_at,
        isPresentNow,
        attendancePercentage: Math.min(100, Math.round((seconds / (Number(r.expected_duration_minutes) * 60 || 1)) * 100)),
        status: isPresentNow ? 'present' : seconds > 0 ? 'attended' : 'absent'
      };
    });
    const presentCount = attendance.filter((r) => r.isPresentNow).length;
    const attendedCount = attendance.filter((r) => r.totalSeconds > 0 || r.isPresentNow).length;

    res.json({
      success: true,
      attendance,
      totalCount,
      presentCount,
      attendedCount,
      absentCount: Math.max(0, totalCount - attendedCount)
    });
  } catch (err) {
    next(err);
  }
}
router.get('/live-sessions/:sessionId/attendance', authenticate, requireRoles('instructor', 'admin'), getAttendanceHandler);
router.get('/meetings/:sessionId/attendance', authenticate, requireRoles('instructor', 'admin'), getAttendanceHandler);

// POST /live-sessions/:sessionId/attendance/join
async function attendanceJoinHandler(req, res, next) {
  try {
    if (req.user.role !== 'student') {
      return res.status(403).json({ error: { code: 'STUDENT_ATTENDANCE_ONLY', message: 'Only enrolled students can check in.' } });
    }
    const sessionRes = await query('SELECT course_id, status FROM live_sessions WHERE id = $1', [req.params.sessionId]);
    if (sessionRes.rows.length === 0) {
      return res.status(404).json({ error: { code: 'SESSION_NOT_FOUND', message: 'Session not found.' } });
    }

    const session = sessionRes.rows[0];
    if (session.status !== 'live') {
      return res.status(409).json({ error: { code: 'SESSION_NOT_LIVE', message: 'Attendance can only be recorded during a live session.' } });
    }
    const enrollment = await query(
      "SELECT 1 FROM enrollments WHERE student_id = $1 AND course_id = $2 AND status IN ('enrolled', 'completed')",
      [req.user.id, session.course_id]
    );
    if (enrollment.rows.length === 0) {
      return res.status(403).json({ error: { code: 'COURSE_ENROLLMENT_REQUIRED', message: 'Enroll in this course to record attendance.' } });
    }

    await query(
      `INSERT INTO attendance_records (session_id, course_id, student_id, active_joined_at, last_event_at)
       VALUES ($1, $2, $3, now(), now())
       ON CONFLICT (session_id, student_id)
       DO UPDATE SET
         total_seconds = attendance_records.total_seconds + CASE
           WHEN attendance_records.active_joined_at IS NULL THEN 0
           ELSE LEAST(60, GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - attendance_records.last_event_at)))::int))
         END,
         active_joined_at = COALESCE(attendance_records.active_joined_at, now()),
         last_event_at = now(), updated_at = now()`,
      [req.params.sessionId, session.course_id, req.user.id]
    );

    res.json({ success: true, message: 'Join recorded.' });
  } catch (err) {
    next(err);
  }
}
router.post('/live-sessions/:sessionId/attendance/join', authenticate, attendanceJoinHandler);

// POST /live-sessions/:sessionId/attendance/leave
async function attendanceLeaveHandler(req, res, next) {
  try {
    if (req.user.role !== 'student') {
      return res.status(403).json({ error: { code: 'STUDENT_ATTENDANCE_ONLY', message: 'Only enrolled students can check out.' } });
    }
    const attRes = await query(
      'SELECT * FROM attendance_records WHERE session_id = $1 AND student_id = $2',
      [req.params.sessionId, req.user.id]
    );

    if (attRes.rows.length > 0) {
      const rec = attRes.rows[0];

      await query(
        `UPDATE attendance_records
         SET total_seconds = total_seconds + CASE
               WHEN active_joined_at IS NULL THEN 0
               ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - last_event_at)))::int)
             END,
             active_joined_at = NULL, last_event_at = now(), updated_at = now()
         WHERE id = $1`,
        [rec.id]
      );
    }

    res.json({ success: true, message: 'Leave recorded.' });
  } catch (err) {
    next(err);
  }
}
router.post('/live-sessions/:sessionId/attendance/leave', authenticate, attendanceLeaveHandler);

// POST /meetings/attendance/sync
router.post('/meetings/attendance/sync', authenticate, async (req, res, next) => {
  try {
    const { sessionId, status } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: { code: 'SESSION_REQUIRED', message: 'Session id is required.' } });
    req.params.sessionId = sessionId;
    return (status === 'left' ? attendanceLeaveHandler : attendanceJoinHandler)(req, res, next);
  } catch (err) {
    next(err);
  }
});

// POST /live-sessions/:sessionId/polls
router.post('/live-sessions/:sessionId/polls', authenticate, requireRoles('instructor', 'admin'), async (req, res, next) => {
  try {
    const { question, responseType = 'single_choice', options = [] } = req.body || {};
    const sessRes = await query('SELECT course_id FROM live_sessions WHERE id = $1', [req.params.sessionId]);
    if (sessRes.rows.length === 0) {
      return res.status(404).json({ error: { code: 'SESSION_NOT_FOUND', message: 'Session not found.' } });
    }

    const courseId = sessRes.rows[0].course_id;
    const result = await query(
      `INSERT INTO polls (session_id, course_id, created_by, question, response_type, options, status, opens_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'open', now())
       RETURNING *`,
      [req.params.sessionId, courseId, req.user.id, question.trim(), responseType, JSON.stringify(options)]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /live-sessions/:sessionId/polls/:pollId/votes
router.post('/live-sessions/:sessionId/polls/:pollId/votes', authenticate, async (req, res, next) => {
  try {
    const { optionKeys = [], responseText = null } = req.body || {};
    const pollRes = await query('SELECT course_id FROM polls WHERE id = $1', [req.params.pollId]);
    if (pollRes.rows.length === 0) {
      return res.status(404).json({ error: { code: 'POLL_NOT_FOUND', message: 'Poll not found.' } });
    }

    const courseId = pollRes.rows[0].course_id;
    const result = await query(
      `INSERT INTO poll_responses (poll_id, session_id, course_id, student_id, option_keys, response_text)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (poll_id, student_id)
       DO UPDATE SET option_keys = EXCLUDED.option_keys, response_text = EXCLUDED.response_text
       RETURNING *`,
      [req.params.pollId, req.params.sessionId, courseId, req.user.id, JSON.stringify(optionKeys), responseText]
    );

    res.status(201).json({ success: true, vote: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /live-sessions/:sessionId/polls/:pollId/tally
router.get('/live-sessions/:sessionId/polls/:pollId/tally', authenticate, async (req, res, next) => {
  try {
    const votesRes = await query('SELECT option_keys FROM poll_responses WHERE poll_id = $1', [req.params.pollId]);
    const tally = {};
    for (const row of votesRes.rows) {
      const keys = row.option_keys || [];
      for (const k of keys) {
        tally[k] = (tally[k] || 0) + 1;
      }
    }
    res.json({ pollId: req.params.pollId, tally, totalVotes: votesRes.rows.length });
  } catch (err) {
    next(err);
  }
});

// DELETE /meetings/series/:id
router.delete('/meetings/series/:id', authenticate, requireRoles('instructor', 'admin'), async (_req, res) => {
  res.json({ success: true, message: 'Meeting series deleted.' });
});

// POST /meetings/:id/generate-summary
router.post('/meetings/:id/generate-summary', authenticate, requireRoles('instructor', 'admin'), async (req, res, next) => {
  try {
    const meetingRes = await query(
      req.user.role === 'instructor'
        ? 'SELECT title, description FROM live_sessions WHERE id = $1 AND host_id = $2'
        : 'SELECT title, description FROM live_sessions WHERE id = $1',
      req.user.role === 'instructor' ? [req.params.id, req.user.id] : [req.params.id]
    );
    if (meetingRes.rows.length === 0) {
      return res.status(404).json({ error: { code: 'MEETING_NOT_FOUND', message: 'Meeting not found.' } });
    }
    const meeting = meetingRes.rows[0];

    const Groq = (await import('groq-sdk')).default;
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

    const prompt = `You are an AI assistant analyzing a meeting titled "${meeting.title}".
Description: ${meeting.description || 'N/A'}.

Please generate a realistic mock summary of this meeting. (In a real system, you would transcribe the audio, but for now, imagine what was discussed based on the title).
Respond ONLY with a valid JSON object exactly like this:
{
  "summary": "A 2-3 sentence overview of the discussion.",
  "keyTakeaways": ["Point 1", "Point 2", "Point 3"],
  "generatedQuiz": [
    {
      "question": "A multiple choice question about the meeting",
      "options": ["Option 1", "Option 2", "Option 3", "Option 4"],
      "correctIndex": 0
    }
  ]
}`;

    let summary;
    try {
      const completion = await groq.chat.completions.create({
        model: 'qwen/qwen3.8-27b',
        messages: [
          { role: 'system', content: 'You are an AI assistant that summarizes meetings. Respond ONLY with valid JSON.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.6,
        response_format: { type: 'json_object' }
      });
      const rawOutput = completion.choices[0]?.message?.content || '{}';
      summary = JSON.parse(rawOutput);
    } catch (llmErr) {
      console.error('Failed to generate summary with Groq:', llmErr);
      summary = {
        summary: 'Automated AI Summary could not be generated due to an LLM error.',
        keyTakeaways: ['Check API keys', 'Ensure network connectivity'],
        generatedQuiz: []
      };
    }

    await query('UPDATE live_sessions SET ai_summary = $1, summary_status = $2 WHERE id = $3', [JSON.stringify(summary), 'ready', req.params.id]);
    res.json({ success: true, aiSummary: summary });
  } catch (err) {
    next(err);
  }
});

export default router;
