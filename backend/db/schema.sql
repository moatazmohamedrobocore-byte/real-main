-- REAL_i PostgreSQL Schema
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Users Table
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         VARCHAR(254) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          VARCHAR(120) NOT NULL,
  role          VARCHAR(20) NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'instructor', 'admin')),
  avatar        TEXT DEFAULT NULL,
  last_login_at TIMESTAMPTZ,
  deleted_at    TIMESTAMPTZ DEFAULT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_role_active ON users(role) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Refresh Tokens
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id   UUID NOT NULL DEFAULT gen_random_uuid(),
  jti         VARCHAR(64) NOT NULL UNIQUE,
  token_hash  VARCHAR(128) NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ DEFAULT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_family ON refresh_tokens(family_id);
CREATE INDEX IF NOT EXISTS idx_refresh_jti ON refresh_tokens(jti);

-- Courses Table
CREATE TABLE IF NOT EXISTS courses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title           VARCHAR(200) NOT NULL,
  description     TEXT NOT NULL,
  category        VARCHAR(80) DEFAULT NULL,
  difficulty      VARCHAR(20) DEFAULT NULL CHECK (difficulty IN ('beginner', 'intermediate', 'advanced') OR difficulty IS NULL),
  pricing_access  VARCHAR(10) NOT NULL DEFAULT 'free' CHECK (pricing_access IN ('free', 'paid')),
  pricing_currency VARCHAR(3) DEFAULT NULL,
  pricing_amount  NUMERIC(10,2) DEFAULT NULL,
  instructor_id   UUID NOT NULL REFERENCES users(id),
  status          VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  enrollment_open BOOLEAN NOT NULL DEFAULT true,
  thumbnail       TEXT DEFAULT NULL,
  published_at    TIMESTAMPTZ DEFAULT NULL,
  archived_at     TIMESTAMPTZ DEFAULT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_courses_instructor ON courses(instructor_id, status);
CREATE INDEX IF NOT EXISTS idx_courses_published ON courses(status, published_at DESC) WHERE status = 'published';
CREATE INDEX IF NOT EXISTS idx_courses_catalog ON courses(status, category, difficulty);

-- Lessons Table
CREATE TABLE IF NOT EXISTS lessons (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id    UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title        VARCHAR(200) NOT NULL,
  content      TEXT NOT NULL,
  position     INT NOT NULL CHECK (position >= 1),
  status       VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  published_at TIMESTAMPTZ DEFAULT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(course_id, position)
);
CREATE INDEX IF NOT EXISTS idx_lessons_course_position ON lessons(course_id, position);

-- Enrollments Table
CREATE TABLE IF NOT EXISTS enrollments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id        UUID NOT NULL REFERENCES users(id),
  course_id         UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  status            VARCHAR(20) NOT NULL DEFAULT 'enrolled' CHECK (status IN ('enrolled', 'dropped', 'completed')),
  enrolled_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  dropped_at        TIMESTAMPTZ DEFAULT NULL,
  completed_at      TIMESTAMPTZ DEFAULT NULL,
  completion_source VARCHAR(20) DEFAULT NULL CHECK (completion_source IN ('instructor', 'system') OR completion_source IS NULL),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_enrollment_active ON enrollments(student_id, course_id) WHERE status = 'enrolled';
CREATE INDEX IF NOT EXISTS idx_enrollment_student ON enrollments(student_id, status);
CREATE INDEX IF NOT EXISTS idx_enrollment_course ON enrollments(course_id, status);

-- Assessments Table
CREATE TABLE IF NOT EXISTS assessments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id           UUID REFERENCES courses(id) ON DELETE CASCADE,
  author_id           UUID NOT NULL REFERENCES users(id),
  title               VARCHAR(200) NOT NULL,
  instructions        TEXT DEFAULT '',
  type                VARCHAR(20) NOT NULL DEFAULT 'quiz' CHECK (type IN ('quiz', 'exam', 'assignment', 'task')),
  status              VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  time_limit_seconds  INT NOT NULL DEFAULT 600 CHECK (time_limit_seconds BETWEEN 60 AND 28800),
  randomize_questions BOOLEAN NOT NULL DEFAULT true,
  max_attempts        INT NOT NULL DEFAULT 1 CHECK (max_attempts BETWEEN 1 AND 20),
  available_from      TIMESTAMPTZ DEFAULT NULL,
  due_at              TIMESTAMPTZ DEFAULT NULL,
  questions           JSONB NOT NULL DEFAULT '[]'::jsonb,
  published_at        TIMESTAMPTZ DEFAULT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_assessments_course ON assessments(course_id, status);
ALTER TABLE assessments ALTER COLUMN course_id DROP NOT NULL;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS type VARCHAR(20) NOT NULL DEFAULT 'quiz';

-- Submissions Table
CREATE TABLE IF NOT EXISTS submissions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id           UUID NOT NULL REFERENCES users(id),
  course_id            UUID REFERENCES courses(id) ON DELETE CASCADE,
  lesson_id            UUID REFERENCES lessons(id) ON DELETE SET NULL,
  assessment_id        UUID REFERENCES assessments(id) ON DELETE SET NULL,
  kind                 VARCHAR(20) NOT NULL DEFAULT 'lesson' CHECK (kind IN ('lesson', 'assessment')),
  attempt_number       INT NOT NULL DEFAULT 1,
  submission_type      VARCHAR(20) NOT NULL DEFAULT 'mcq' CHECK (submission_type IN ('mcq', 'short_answer', 'true_false', 'essay')),
  responses            JSONB NOT NULL DEFAULT '[]'::jsonb,
  started_at           TIMESTAMPTZ DEFAULT NULL,
  expires_at           TIMESTAMPTZ DEFAULT NULL,
  attempt_status       VARCHAR(35) NOT NULL DEFAULT 'submitted' CHECK (attempt_status IN ('in_progress', 'submitted', 'timed_out', 'finalized_due_date', 'finalized_eligibility_lost')),
  expiration_reason    VARCHAR(20) DEFAULT NULL CHECK (expiration_reason IN ('time_limit', 'due_date') OR expiration_reason IS NULL),
  finalization_reason  VARCHAR(20) DEFAULT NULL CHECK (finalization_reason IN ('manual_submit', 'timeout', 'due_date', 'eligibility_lost') OR finalization_reason IS NULL),
  question_order       JSONB DEFAULT '[]'::jsonb,
  question_snapshot    JSONB DEFAULT NULL,
  submitted_at         TIMESTAMPTZ DEFAULT now(),
  grading_status       VARCHAR(20) DEFAULT 'pending' CHECK (grading_status IN ('pending', 'auto_graded', 'manual_review', 'graded')),
  grading_score        NUMERIC(5,2) DEFAULT NULL,
  grading_feedback     TEXT DEFAULT NULL,
  grading_comments     TEXT DEFAULT NULL,
  grading_suggestions  TEXT DEFAULT NULL,
  graded_by            UUID REFERENCES users(id),
  graded_at            TIMESTAMPTZ DEFAULT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_submission_course ON submissions(course_id, kind, grading_status);
CREATE INDEX IF NOT EXISTS idx_submission_student ON submissions(student_id, course_id);
ALTER TABLE submissions ALTER COLUMN course_id DROP NOT NULL;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS grading_comments TEXT DEFAULT NULL;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS grading_suggestions TEXT DEFAULT NULL;

-- Assignment uploads are stored as PostgreSQL BYTEA values, linked to the submission.
CREATE TABLE IF NOT EXISTS assessment_submission_files (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id  UUID NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  original_name  VARCHAR(500) NOT NULL,
  mime_type      VARCHAR(255) NOT NULL DEFAULT 'application/octet-stream',
  file_size      BIGINT NOT NULL CHECK (file_size > 0),
  file_data      BYTEA NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_assessment_submission_files_submission ON assessment_submission_files(submission_id);

-- Live Sessions (Meetings)
CREATE TABLE IF NOT EXISTS live_sessions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id        UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  host_id          UUID NOT NULL REFERENCES users(id),
  provider         VARCHAR(20) NOT NULL DEFAULT 'jitsi',
  provider_room_id VARCHAR(200) NOT NULL UNIQUE,
  title            VARCHAR(200) NOT NULL,
  description      TEXT DEFAULT '',
  starts_at        TIMESTAMPTZ NOT NULL,
  ends_at          TIMESTAMPTZ NOT NULL,
  status           VARCHAR(20) NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'live', 'ended', 'cancelled')),
  summary_status   VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (summary_status IN ('pending', 'ready', 'failed')),
  ai_summary       JSONB DEFAULT NULL,
  settings         JSONB DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sessions_course ON live_sessions(course_id, starts_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON live_sessions(status, starts_at);

-- Attendance Records Table
CREATE TABLE IF NOT EXISTS attendance_records (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id       UUID NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  course_id        UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  student_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  intervals        JSONB DEFAULT '[]'::jsonb,
  active_joined_at TIMESTAMPTZ DEFAULT NULL,
  total_seconds    INT NOT NULL DEFAULT 0,
  last_event_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(session_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_attendance_session ON attendance_records(session_id);

-- Polls Table
CREATE TABLE IF NOT EXISTS polls (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    UUID NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  course_id     UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  created_by    UUID NOT NULL REFERENCES users(id),
  question      VARCHAR(2000) NOT NULL,
  response_type VARCHAR(20) NOT NULL CHECK (response_type IN ('single_choice', 'multiple_choice', 'free_text')),
  options       JSONB DEFAULT '[]'::jsonb,
  status        VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'closed')),
  opens_at      TIMESTAMPTZ DEFAULT NULL,
  closes_at     TIMESTAMPTZ DEFAULT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_polls_session ON polls(session_id, status);

-- Poll Responses Table
CREATE TABLE IF NOT EXISTS poll_responses (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  poll_id       UUID NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  session_id    UUID NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  course_id     UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  student_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  option_keys   JSONB DEFAULT '[]'::jsonb,
  response_text TEXT DEFAULT NULL,
  submitted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(poll_id, student_id)
);

-- Calendar Events Table
CREATE TABLE IF NOT EXISTS calendar_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope       VARCHAR(10) NOT NULL DEFAULT 'global' CHECK (scope IN ('global', 'course')),
  course_id   UUID REFERENCES courses(id) ON DELETE CASCADE,
  title       VARCHAR(200) NOT NULL,
  description TEXT DEFAULT '',
  event_type  VARCHAR(20) NOT NULL DEFAULT 'custom' CHECK (event_type IN ('custom', 'meeting')),
  starts_at   TIMESTAMPTZ NOT NULL,
  ends_at     TIMESTAMPTZ DEFAULT NULL,
  status      VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  created_by  UUID NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS event_type VARCHAR(20) NOT NULL DEFAULT 'custom';
CREATE INDEX IF NOT EXISTS idx_calendar_events ON calendar_events(scope, status, starts_at);

-- Notifications Table
CREATE TABLE IF NOT EXISTS notifications (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type              VARCHAR(30) NOT NULL CHECK (type IN ('assessment_graded', 'calendar_reminder', 'system')),
  payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
  deduplication_key VARCHAR(200) DEFAULT NULL,
  read_at           TIMESTAMPTZ DEFAULT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications(recipient_id, read_at, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_recipient_dedup ON notifications(recipient_id, deduplication_key) WHERE deduplication_key IS NOT NULL;

-- Lesson Progress Table
CREATE TABLE IF NOT EXISTS lesson_progress (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lesson_id    UUID NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  course_id    UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, lesson_id)
);
CREATE INDEX IF NOT EXISTS idx_lesson_progress_user ON lesson_progress(user_id, course_id);

-- AI Guidelines Table
CREATE TABLE IF NOT EXISTS ai_guidelines (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope        VARCHAR(10) NOT NULL DEFAULT 'global' CHECK (scope IN ('global', 'course')),
  course_id    UUID REFERENCES courses(id) ON DELETE CASCADE,
  version      INT NOT NULL DEFAULT 1,
  task_type    VARCHAR(80) NOT NULL DEFAULT 'Global Directive',
  priority     VARCHAR(20) NOT NULL DEFAULT 'Normal',
  status       VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
  is_active    BOOLEAN NOT NULL DEFAULT false,
  content      TEXT NOT NULL,
  created_by   UUID NOT NULL REFERENCES users(id),
  activated_at TIMESTAMPTZ DEFAULT NULL,
  archived_at  TIMESTAMPTZ DEFAULT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_guidelines_scope ON ai_guidelines(scope, course_id, status);
ALTER TABLE ai_guidelines ADD COLUMN IF NOT EXISTS task_type VARCHAR(80) NOT NULL DEFAULT 'Global Directive';
ALTER TABLE ai_guidelines ADD COLUMN IF NOT EXISTS priority VARCHAR(20) NOT NULL DEFAULT 'Normal';
ALTER TABLE ai_guidelines ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT false;
UPDATE ai_guidelines SET is_active = (status = 'active') WHERE is_active IS DISTINCT FROM (status = 'active');

-- Data Assets Table
CREATE TABLE IF NOT EXISTS data_assets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id   UUID REFERENCES courses(id) ON DELETE CASCADE,
  asset_name  VARCHAR(500) NOT NULL,
  asset_type  VARCHAR(100) DEFAULT 'file',
  asset_size  BIGINT DEFAULT 0,
  file_path   TEXT DEFAULT NULL,
  chunk_count INT NOT NULL DEFAULT 0,
  processed_at TIMESTAMPTZ DEFAULT NULL,
  indexed_at  TIMESTAMPTZ DEFAULT NULL,
  uploaded_by UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_data_assets_course ON data_assets(course_id);
ALTER TABLE data_assets ADD COLUMN IF NOT EXISTS chunk_count INT NOT NULL DEFAULT 0;
ALTER TABLE data_assets ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE data_assets ADD COLUMN IF NOT EXISTS indexed_at TIMESTAMPTZ DEFAULT NULL;

-- Chat Sessions Table
CREATE TABLE IF NOT EXISTS chat_sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id   UUID REFERENCES courses(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Chat Messages Table
CREATE TABLE IF NOT EXISTS chat_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role        VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, created_at);

-- Quiz Results Table
CREATE TABLE IF NOT EXISTS quiz_results (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id     VARCHAR(200) NOT NULL,
  score       INT NOT NULL,
  total       INT NOT NULL,
  answers     JSONB DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(student_id, task_id)
);

CREATE TABLE IF NOT EXISTS system_settings (
  singleton_key       BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton_key),
  academy_name        VARCHAR(200) NOT NULL DEFAULT 'REAL_i Academy',
  support_email       VARCHAR(254) NOT NULL DEFAULT 'support@real-i.local',
  language            VARCHAR(20) NOT NULL DEFAULT 'English',
  ai_enabled          BOOLEAN NOT NULL DEFAULT true,
  ai_model            VARCHAR(100) NOT NULL DEFAULT 'qwen/qwen3.8-27b',
  ai_personality      VARCHAR(50) NOT NULL DEFAULT 'Professional',
  maintenance_mode    BOOLEAN NOT NULL DEFAULT false,
  restrict_enrollment BOOLEAN NOT NULL DEFAULT false,
  two_factor_auth     BOOLEAN NOT NULL DEFAULT false,
  stripe_key          TEXT DEFAULT '',
  zoom_client         TEXT DEFAULT '',
  updated_by          UUID REFERENCES users(id),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO system_settings (singleton_key) VALUES (true) ON CONFLICT (singleton_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS admin_tasks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by  UUID NOT NULL REFERENCES users(id),
  request       TEXT NOT NULL,
  response      TEXT NOT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'completed' CHECK (status IN ('pending', 'completed', 'failed')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_admin_tasks_created ON admin_tasks(created_at DESC);

-- Password Resets Table
CREATE TABLE IF NOT EXISTS password_resets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  otp_hash    TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ DEFAULT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id);
