import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import { query } from '../db/pool.js';
import pool from '../db/pool.js';
import { authenticate, requireRoles } from '../middleware/auth.js';
import { getAccessSecret, getRefreshSecret, getJitsiSecret } from '../config/secrets.js';

const router = Router();
const HERE = path.dirname(fileURLToPath(import.meta.url));

// ─── Helpers ────────────────────────────────────────────────────────────────

/**  Map a raw 0-100 score to a letter grade. */
function letterGrade(score) {
  if (score >= 95) return 'A+';
  if (score >= 90) return 'A';
  if (score >= 85) return 'A-';
  if (score >= 80) return 'B+';
  if (score >= 75) return 'B';
  if (score >= 70) return 'B-';
  if (score >= 65) return 'C+';
  if (score >= 60) return 'C';
  if (score >= 55) return 'C-';
  if (score >= 50) return 'D';
  return 'F';
}

function severityWeight(severity) {
  switch (severity) {
    case 'critical': return 25;
    case 'high':     return 15;
    case 'medium':   return 8;
    case 'low':      return 3;
    default:         return 5;
  }
}

// ─── Security findings: catalog + evidence-driven status ────────────────────
// IDs follow the production-readiness remediation brief (F-01..F-25), which is the
// numbering used by the merged remediation PRs, the commit messages and the regression
// tests in backend/tests/. (docs/security-hardening-audit.md numbers its findings #1..#13
// independently — do not mix the two.)
//
// A finding is only reported as closed when there is evidence:
//   test   -> a regression test whose title names the finding
//   runtime-> a check evaluated against this live process's configuration
// Everything else is 'open', or 'partial' when evidence exists but the brief's scope
// for that finding is not fully met (the remaining work is stated in `residual`).

const SECURITY_CATALOG = [
  { id: 'F-01', title: 'Assessment submission workflow: started attempts recorded as submitted; submit path 500s', severity: 'critical', category: 'Data Integrity' },
  { id: 'F-02', title: 'Unpublished courses/lessons and lesson bodies visible to non-staff',                      severity: 'critical', category: 'Access Control' },
  { id: 'F-03', title: 'Assessment answer keys returned in student-facing payloads',                             severity: 'critical', category: 'Data Exposure' },
  { id: 'F-04', title: 'Students can start or submit unpublished assessments / courses they did not join',        severity: 'critical', category: 'Access Control' },
  { id: 'F-05', title: 'Cross-user reads of attempts, results and completed-quiz history (IDOR)',                 severity: 'high',     category: 'Access Control' },
  { id: 'F-06', title: 'Quiz results forgeable: client-supplied student id and score',                           severity: 'critical', category: 'Data Integrity' },
  { id: 'F-07', title: 'AI chat sessions readable, writable or deletable by non-owners',                         severity: 'high',     category: 'Access Control' },
  { id: 'F-08', title: 'Video/refresh tokens accepted as API access tokens; JWT algorithm unpinned',              severity: 'critical', category: 'Access Control' },
  { id: 'F-09', title: 'No server-enforced time limit or due date; expired attempts still submittable',           severity: 'high',     category: 'Data Integrity' },
  { id: 'F-10', title: 'Grading correctness: multi-select partial credit, open-ended auto-scored 0, uncapped',     severity: 'high',     category: 'Data Integrity' },
  { id: 'F-11', title: 'Logout does not revoke the refresh-token family',                                        severity: 'medium',   category: 'Session Security' },
  { id: 'F-12', title: 'Login throttling bypass via non-normalised rate-limit keys; no per-IP cap',               severity: 'high',     category: 'Network' },
  { id: 'F-13', title: 'Uploads, asset inventory and indexing available to non-admins',                           severity: 'high',     category: 'Access Control' },
  { id: 'F-14', title: 'Stored files served with uploader-controlled content type (inline execution)',            severity: 'medium',   category: 'Data Exposure' },
  { id: 'F-15', title: 'Paid courses self-enrollable without a payment entitlement',                             severity: 'high',     category: 'Business Logic' },
  { id: 'F-17', title: 'AI engine hardening: provider timeouts/retries, output schema validation, eval harness',   severity: 'medium',   category: 'AI Safety' },
  { id: 'F-18', title: 'Password change without current-password proof; sessions not revoked; self role escalation',severity: 'high',   category: 'Account Security' },
  { id: 'F-19', title: 'Join tokens share the API signing secret (distinct purpose needs distinct key)',          severity: 'medium',   category: 'Session Security' },
  { id: 'F-20', title: 'Chat input unvalidated (empty, non-string, oversized messages)',                         severity: 'medium',   category: 'AI Safety' },
  { id: 'F-21', title: 'No consistent request schema-validation layer',                                          severity: 'medium',   category: 'Robustness' },
  { id: 'F-22', title: 'Health endpoint detail exposure; seeds and dev credentials reachable in production',       severity: 'low',      category: 'Configuration' },
  { id: 'F-25', title: 'Production DB TLS verification disabled; unused/vulnerable deps; committed debris',        severity: 'high',     category: 'Configuration' },
];

// Referenced by the brief's "F-01 through F-25" range but never defined in it.
const UNMAPPED_IDS = ['F-16', 'F-23', 'F-24'];

// Where evidence exists but the brief's scope for that finding is not fully met.
const RESIDUAL_WORK = {
  'F-13': 'Upload permissions and admin-only inventory/indexing are tested, but uploaded bytes are still not content-sniffed against their claimed type, and deleting an asset record does not delete its stored file.',
  'F-14': 'Submission files are force-downloaded unless the extension is inert, but /uploads is still served with extension-derived types, so an admin-uploaded .html or .svg can execute in the application origin for signed-in users.'
};

function collectTestEvidence() {
  const testsDir = path.join(HERE, '..', 'tests');
  const byFinding = new Map();
  let files = [];
  try {
    files = fs.readdirSync(testsDir).filter((f) => f.endsWith('.test.mjs'));
  } catch {
    return { byFinding, available: false, fileCount: 0 };
  }
  for (const file of files) {
    let src;
    try {
      src = fs.readFileSync(path.join(testsDir, file), 'utf8');
    } catch {
      continue;
    }
    for (const m of src.matchAll(/\b(?:test|it)\s*\(\s*[`'"]([^`'"]{3,300})[`'"]/g)) {
      const title = m[1];
      for (const id of title.match(/F-\d{2}/g) || []) {
        if (!byFinding.has(id)) byFinding.set(id, []);
        byFinding.get(id).push({ file, title });
      }
    }
  }
  return { byFinding, available: true, fileCount: files.length };
}

function runtimeChecks() {
  const access = getAccessSecret();
  const refresh = getRefreshSecret();
  const jitsi = getJitsiSecret();
  const secretsDistinct = access !== refresh && jitsi !== access && jitsi !== refresh;
  const ssl = pool.options && pool.options.ssl;
  const tlsVerified = process.env.NODE_ENV !== 'production'
    ? null
    : Boolean(ssl) && ssl.rejectUnauthorized !== false;
  return {
    'F-08': secretsDistinct
      ? { ok: true, note: 'Live check: access, refresh and join-token signing keys are three distinct values.' }
      : { ok: false, note: 'Live check FAILED: token purposes share a signing key.' },
    'F-19': secretsDistinct
      ? { ok: true, note: 'Live check: Jitsi join tokens are signed with a key separate from the API tokens.' }
      : { ok: false, note: 'Live check FAILED: join token shares an API signing key.' },
    'F-25': tlsVerified === null
      ? { ok: false, note: 'Not evaluated (NODE_ENV is not production here).' }
      : tlsVerified
        ? { ok: true, note: 'Live check: production DB connection verifies the server certificate.' }
        : { ok: false, note: 'Live check: production DB TLS is disabled or set to rejectUnauthorized=false.' }
  };
}

function buildFindings(evidence, runtime) {
  return SECURITY_CATALOG.map((f) => {
    const tests = evidence.byFinding.get(f.id) || [];
    const live = runtime[f.id];
    const verifiedBy = [
      ...tests.map((t) => `${t.file}: ${t.title}`),
      ...(live && live.ok ? [live.note] : [])
    ];
    let status;
    if (tests.length && live && !live.ok) status = 'partial';
    else if (tests.length || (live && live.ok)) status = 'verified';
    else status = 'open';
    if (status === 'verified' && RESIDUAL_WORK[f.id]) status = 'partial';

    return {
      ...f,
      status,
      remediated: status === 'verified',
      verifiedBy,
      residual: RESIDUAL_WORK[f.id] || null,
      notes: status === 'verified'
        ? `Closed on evidence: ${tests.length} regression test(s)${live && live.ok ? ' + 1 live configuration check' : ''}.`
        : status === 'partial'
          ? (live && !live.ok ? live.note : RESIDUAL_WORK[f.id])
          : (live && live.note ? live.note : 'No regression test and no live check proves closure.')
    };
  });
}

// ─── GET /admin/audit/rating ────────────────────────────────────────────────
// Returns the full audit scorecard — security, content quality, user activity,
// platform performance.

router.get('/admin/audit/rating', authenticate, requireRoles('admin'), async (_req, res, next) => {
  try {
    // ── 1. Security: evidence-driven ────────────────────────────────────
    const evidence = collectTestEvidence();
    const runtime = runtimeChecks();
    const findings = buildFindings(evidence, runtime);

    const weight = (f) => severityWeight(f.severity);
    const totalWeight = findings.reduce((s, f) => s + weight(f), 0);
    // verified counts fully, partial counts half, open counts nothing.
    const credited = findings.reduce(
      (s, f) => s + (f.status === 'verified' ? weight(f) : f.status === 'partial' ? weight(f) * 0.5 : 0),
      0
    );
    const securityScore = Math.round((credited / totalWeight) * 100);

    // ── 2. Content quality ──────────────────────────────────────────────
    const [coursesRes, lessonsRes, assessmentsRes, publishedRes] = await Promise.all([
      query('SELECT COUNT(*) AS total FROM courses'),
      query('SELECT COUNT(*) AS total FROM lessons'),
      query('SELECT COUNT(*) AS total FROM assessments'),
      query("SELECT COUNT(*) AS total FROM courses WHERE status = 'published'"),
    ]);
    const totalCourses    = Number(coursesRes.rows[0]?.total || 0);
    const totalLessons    = Number(lessonsRes.rows[0]?.total || 0);
    const totalAssessments = Number(assessmentsRes.rows[0]?.total || 0);
    const publishedCourses = Number(publishedRes.rows[0]?.total || 0);

    const avgLessonsPerCourse = totalCourses > 0 ? Math.round((totalLessons / totalCourses) * 10) / 10 : 0;
    const publishRatio        = totalCourses > 0 ? Math.round((publishedCourses / totalCourses) * 100) : 0;
    const assessmentCoverage  = totalCourses > 0 ? Math.min(100, Math.round((totalAssessments / totalCourses) * 100)) : 0;

    // Content quality score: weighted composite
    const contentScore = Math.round(
      publishRatio * 0.4 +
      Math.min(100, avgLessonsPerCourse * 10) * 0.3 +  // 10+ lessons = 100
      assessmentCoverage * 0.3
    );

    // ── 3. User engagement ──────────────────────────────────────────────
    const [usersRes, enrollRes, completionRes, activeRes, chatRes, attendanceRes] = await Promise.all([
      query("SELECT COUNT(*) AS total FROM users WHERE deleted_at IS NULL"),
      query('SELECT COUNT(*) AS total FROM enrollments'),
      query("SELECT COUNT(*) AS total FROM enrollments WHERE status = 'completed'"),
      query("SELECT COUNT(*) AS total FROM users WHERE last_login_at > now() - interval '30 days' AND deleted_at IS NULL"),
      query('SELECT COUNT(*) AS total FROM chat_messages'),
      query('SELECT COUNT(*) AS total FROM attendance_records WHERE total_seconds > 0'),
    ]);

    const totalUsers         = Number(usersRes.rows[0]?.total || 0);
    const totalEnrollments   = Number(enrollRes.rows[0]?.total || 0);
    const completedEnroll    = Number(completionRes.rows[0]?.total || 0);
    const activeUsers30d     = Number(activeRes.rows[0]?.total || 0);
    const totalChatMessages  = Number(chatRes.rows[0]?.total || 0);
    const attendanceRecords  = Number(attendanceRes.rows[0]?.total || 0);

    const completionRate    = totalEnrollments > 0 ? Math.round((completedEnroll / totalEnrollments) * 100) : 0;
    const activeUserRate    = totalUsers > 0 ? Math.round((activeUsers30d / totalUsers) * 100) : 0;
    const enrollmentRatio   = totalUsers > 0 ? Math.round((totalEnrollments / totalUsers) * 100) : 0;

    const engagementScore = Math.round(
      Math.min(100, activeUserRate) * 0.35 +
      completionRate * 0.30 +
      Math.min(100, enrollmentRatio) * 0.20 +
      (totalChatMessages > 0 ? 15 : 0)           // AI tutor usage bonus
    );

    // ── 4. Platform performance ─────────────────────────────────────────
    const [settingsRes, guidelinesRes, notifRes, sessionsRes] = await Promise.all([
      query('SELECT * FROM system_settings WHERE singleton_key = true LIMIT 1'),
      query("SELECT COUNT(*) AS total FROM ai_guidelines WHERE status = 'active'"),
      query('SELECT COUNT(*) AS total FROM notifications'),
      query('SELECT COUNT(*) AS total FROM live_sessions'),
    ]);

    const settings       = settingsRes.rows[0] || {};
    const aiEnabled      = settings.ai_enabled !== false;
    const maintenanceOff = settings.maintenance_mode !== true;
    const activeGuidelines = Number(guidelinesRes.rows[0]?.total || 0);
    const totalNotifications = Number(notifRes.rows[0]?.total || 0);
    const totalSessions  = Number(sessionsRes.rows[0]?.total || 0);

    const performanceScore = Math.round(
      (aiEnabled ? 30 : 0) +
      (maintenanceOff ? 20 : 0) +
      (activeGuidelines > 0 ? 15 : 0) +
      Math.min(15, totalSessions * 3) +     // up to 15 for live sessions
      Math.min(20, totalNotifications)        // up to 20 for notification health
    );

    // ── 5. Overall ──────────────────────────────────────────────────────
    const overallScore = Math.round(
      securityScore * 0.35 +
      contentScore * 0.25 +
      engagementScore * 0.25 +
      performanceScore * 0.15
    );

    res.json({
      timestamp: new Date().toISOString(),
      overall: {
        score: overallScore,
        grade: letterGrade(overallScore),
        label: overallScore >= 80 ? 'Excellent' : overallScore >= 60 ? 'Good' : overallScore >= 40 ? 'Needs Improvement' : 'Critical',
      },
      categories: {
        security: {
          score: securityScore,
          grade: letterGrade(securityScore),
          weight: '35%',
          scoring: 'severity-weighted; verified counts fully, partial half, open nothing',
          evidence: {
            testsAvailable: evidence.available,
            testFilesScanned: evidence.fileCount,
            unmappedFindingIds: UNMAPPED_IDS
          },
          findings,
          stats: {
            totalFindings: findings.length,
            remediated: findings.filter((f) => f.status === 'verified').length,
            partial: findings.filter((f) => f.status === 'partial').length,
            open: findings.filter((f) => f.status === 'open').length,
            critical: findings.filter((f) => f.severity === 'critical' && f.status !== 'verified').length,
            high: findings.filter((f) => f.severity === 'high' && f.status !== 'verified').length,
            medium: findings.filter((f) => f.severity === 'medium' && f.status !== 'verified').length,
          },
        },
        content: {
          score: contentScore,
          grade: letterGrade(contentScore),
          weight: '25%',
          stats: {
            totalCourses,
            publishedCourses,
            totalLessons,
            totalAssessments,
            avgLessonsPerCourse,
            publishRatio,
            assessmentCoverage,
          },
        },
        engagement: {
          score: engagementScore,
          grade: letterGrade(engagementScore),
          weight: '25%',
          stats: {
            totalUsers,
            activeUsers30d,
            activeUserRate,
            totalEnrollments,
            completedEnroll,
            completionRate,
            totalChatMessages,
            attendanceRecords,
          },
        },
        performance: {
          score: performanceScore,
          grade: letterGrade(performanceScore),
          weight: '15%',
          stats: {
            aiEnabled,
            maintenanceMode: !maintenanceOff,
            activeGuidelines,
            totalNotifications,
            totalSessions,
            academyName: settings.academy_name || 'REAL_i Academy',
          },
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
