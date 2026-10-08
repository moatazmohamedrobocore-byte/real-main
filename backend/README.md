# REAL_i PostgreSQL Backend

A Node.js/Express backend powering the REAL_i educational web platform, backed by PostgreSQL.

## Architecture & Technology Stack

- **Runtime**: Node.js (ES Modules)
- **Framework**: Express 4
- **Database**: PostgreSQL 16
- **Database Driver**: `pg` (node-postgres with connection pooling)
- **Authentication**: Dual-JWT (access + refresh tokens with rotation and revocation) + bcryptjs password hashing
- **Security & Utilities**: CORS, Morgan HTTP logger, dotenv

### Migration Tool Decision

**Tool chosen: Plain SQL DDL + Node.js runner (`node db/migrate.js`) & `node-pg-migrate` compatibility**

**Justification:**
1. **Zero Abstraction Friction**: Plain SQL DDL (`db/schema.sql`) provides full visibility and control over PostgreSQL native features such as `JSONB`, `UUID` generation via `pgcrypto`, `TIMESTAMPTZ`, foreign key cascade policies, partial unique indexes (`ON enrollments(student_id, course_id) WHERE status = 'enrolled'`), and check constraints.
2. **Performance & Lightweight Footprint**: Avoids the overhead of heavy ORMs like Prisma (which requires binary engines and multi-megabyte generated clients) or Knex (which adds a query-builder layer that is unnecessary when SQL queries are already defined).
3. **Deterministic Seeding & Testing**: The migration script can be run idempotently in any environment with `npm run migrate`.

---

## Getting Started

### 1. Environment Variables

Create `.env` in `./backend` (start from `.env.example`, which documents every variable):

```env
PORT=3001
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/real_i
JWT_SECRET=<32+ random chars>
JWT_ACCESS_SECRET=<a different 32+ random chars>
JWT_REFRESH_SECRET=<a third 32+ random chars>
JWT_EXPIRES_IN=15m
GROQ_API_KEY=<required for chat, quiz generation and summaries>
FRONTEND_URL=http://localhost:3001
NODE_ENV=development
```

Generate distinct secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 2. Install Dependencies

```bash
cd backend
npm install
```

### 3. Run Migrations & Seed

```bash
npm run migrate
npm run seed
```

### 4. Start Server

```bash
npm start
# or for development with auto-reload:
npm run dev
```

---

## Seeded Accounts

| Email | Password | Role |
|-------|----------|------|
| `admin@local.test` | `LocalAdmin1234` | admin |
| `admin2@local.test` | `LocalAdmin1234` | admin |
| `student@local.test` | `LocalStudent1234` | student |

---

## API Endpoints Overview

All routes are mounted at `/v1/*` (primary), `/api/*`, and root shortcuts.

### Authentication (`/v1/auth`)
- `POST /register`: Registers new student account
- `POST /login`: Authenticates with email and password
- `POST /refresh`: Rotates refresh token and issues new access token
- `POST /logout`: Revokes refresh token
- `GET /me`: Returns currently authenticated user profile

### Courses (`/v1/courses`)
- `GET /`: Course catalog with filter parameters (`category`, `difficulty`, `search`)
- `GET /categories`: Available course categories
- `GET /:id`: Detailed course information including lessons and user progress
- `POST /`: Create course (admin)
- `PATCH /:id`: Update course (admin)
- `DELETE /:id`: Archive course (admin)
- `POST /:id/enroll`: Student self-enrollment
- `POST /:courseId/enroll/:studentId`: Admin enroll student
- `DELETE /:courseId/enroll/:studentId`: Admin unenroll student
- `POST /:courseId/lessons`: Add lesson
- `GET /:courseId/lessons/:lessonId`: Get lesson
- `PATCH /:courseId/lessons/:lessonId`: Update lesson
- `DELETE /:courseId/lessons/:lessonId`: Remove lesson

### Assessments (`/v1/assessments`, `/v1/attempts`)
- `GET /assessments`: List assessments
- `POST /courses/:courseId/assessments`: Create assessment
- `PATCH /assessments/:id`: Update assessment
- `DELETE /assessments/:id`: Delete assessment
- `POST /assessments/:id/publish`: Publish assessment
- `POST /assessments/:id/start`: Start assessment attempt
- `GET /attempts/:id`: Get attempt state
- `PUT /attempts/:id/answers`: Save progress
- `POST /attempts/:id/submit`: Submit attempt and calculate score
- `GET /assessments/:id/submissions`: List submissions for grading
- `PATCH /attempts/:id/grade`: Manual grading override
- `GET /assessments/student/me`: Student's completed assessments

### Meetings / Live Sessions (`/v1/meetings`, `/v1/live-sessions`)
- `GET /meetings`: List live sessions
- `POST /meetings`: Schedule live session
- `PUT /meetings/:id`: Update meeting details
- `DELETE /meetings/:id`: Cancel meeting
- `POST /meetings/:id/launch`: Launch meeting
- `POST /meetings/:id/end`: End meeting
- `POST /live-sessions/:id/join-token`: Issue authenticated Jitsi token
- `POST /live-sessions/:id/attendance/join`: Record student attendance join
- `POST /live-sessions/:id/attendance/leave`: Record student attendance leave
- `GET /live-sessions/:id/attendance`: Attendance report
- `POST /live-sessions/:id/polls`: Create interactive poll
- `POST /live-sessions/:id/polls/:pollId/votes`: Vote on poll
- `GET /live-sessions/:id/polls/:pollId/tally`: Real-time poll tally

### Calendar Events (`/v1/calendar`, `/v1/events`)
- `GET /calendar`: Aggregated calendar (events, live classes, deadlines)
- `POST /calendar/events`: Create platform or course event
- `DELETE /events/:id`: Remove event

### Users (`/v1/users`)
- `GET /`: List all users (admin)
- `GET /:id`: User learning profile, completed lessons, enrollments, and quiz results
- `PUT /:id/role`: Update user role (admin)
- `PUT /:id/profile`: Update profile information (name, avatar, password)
- `POST /:userId/lessons/:lessonId/toggle`: Toggle lesson completion state
- `DELETE /:id`: Deactivate user (admin)

### Admin & Analytics (`/v1/admin`, `/v1/health`, `/v1/analytics`)
- `GET /health` & `GET /admin/health`: Deep health check verifying PostgreSQL connectivity
- `GET /admin/guidelines`: List AI tutoring guidelines
- `POST /admin/guidelines`: Create guideline
- `PUT /admin/guidelines/:id/toggle`: Toggle active status
- `DELETE /admin/guidelines/:id`: Delete guideline
- `GET /analytics/kpis`: Platform KPIs (learners, completion rate, average score, sessions)

### Data & AI Integration (`/v1/data`, `/v1/agent`, `/v1/upload`)
- `GET /data/projects`: List courses as projects
- `GET /data/assets`: List uploaded course assets
- `POST /upload`: Upload course files (stored on disk; **not** indexed or embedded)
- `POST /courses/:id/ai/chat`: Interactive chat with AI tutor Raaed
- `POST /courses/:id/ai/quizzes`: Generate contextual quizzes
- `POST /agent/quizzes/results`: Submit student quiz results
- `GET /agent/quizzes/completed/:id`: Completed quiz history
- `POST /admin/task/create`: Create administrative AI task

See `docs/ai-tutor.md` for what the AI routes actually do, and `docs/security-hardening-audit.md` for the access-control gaps in this list.
