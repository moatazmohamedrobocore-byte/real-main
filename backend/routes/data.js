import { Router } from 'express';
import crypto from 'node:crypto';
import { query } from '../db/pool.js';
import { authenticate, requireRoles, allowAnonymous } from '../middleware/auth.js';
import { getGroqClient, getGroqModel } from '../services/llm.js';
import { indexCourseAssets } from '../services/indexer.js';
import { retrieveChunks, formatContext } from '../services/retrieve.js';

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// F-20: upper bound for one tutor chat message (the JSON body limit is 1 MB; this keeps
// LLM cost and stored history bounded).
const CHAT_MESSAGE_MAX_CHARS = 4000;
// The frontend sometimes passes agent names ("general") or "undefined" as courseId;
// only real UUIDs may hit UUID-typed columns.
const safeCourseId = (value) => (typeof value === 'string' && UUID_RE.test(value) ? value : null);

// AI-quiz answer keys are persisted in Postgres (ai_quiz_keys) so grading survives a
// container restart. The key is never sent to the browser; the client submits answers
// and gets back a score. Rows are swept after a 2-hour TTL.
const AI_QUIZ_TTL_HOURS = 2;
async function sweepAiQuizKeys() {
  try {
    await query(`DELETE FROM ai_quiz_keys WHERE created_at < now() - make_interval(hours => $1)`, [AI_QUIZ_TTL_HOURS]);
  } catch { /* best-effort cleanup */ }
}

// GET /data/projects (matches frontend getProjects())
// Students see only the courses they are enrolled in; staff see the whole catalogue.
router.get('/data/projects', authenticate, async (req, res, next) => {
  try {
    const params = [];
    let scopeClause = '';
    if (req.user.role === 'student') {
      params.push(req.user.id);
      // On learning screens "projects" must be the student's own enrollments only.
      scopeClause = ` AND c.id IN (
          SELECT course_id FROM enrollments WHERE student_id = $1 AND status IN ('enrolled','completed')
        )`;
    }
    const result = await query(
      `SELECT c.*, u.name as instructor_name,
              COUNT(l.id) as lesson_count
       FROM courses c
       LEFT JOIN users u ON u.id = c.instructor_id
       LEFT JOIN lessons l ON l.course_id = c.id
       WHERE c.status != 'archived'${scopeClause}
       GROUP BY c.id, u.name
       ORDER BY c.created_at DESC`,
      params
    );

    // Attach per-student progress so learning screens show real completion.
    let progressByCourse = {};
    if (req.user.role === 'student' && result.rows.length) {
      const progRes = await query(
        'SELECT course_id, COUNT(*) AS done FROM lesson_progress WHERE user_id = $1 GROUP BY course_id',
        [req.user.id]
      );
      progressByCourse = Object.fromEntries(progRes.rows.map((p) => [String(p.course_id), Number(p.done)]));
    }

    const formatted = result.rows.map((c) => {
      const lessonCount = Number(c.lesson_count);
      const done = progressByCourse[String(c.id)] || 0;
      return {
        id: String(c.id),
        project_id: String(c.id),
        title: c.title,
        description: c.description,
        category: c.category || 'Development',
        level: c.difficulty || 'beginner',
        instructor: c.instructor_name || 'Instructor',
        total_hours: Math.max(1, Math.round(lessonCount * 1.5)),
        is_published: c.status === 'published',
        lesson_count: lessonCount,
        completed_lessons: done,
        progress: lessonCount > 0 ? Math.round((done / lessonCount) * 100) : 0,
        modules: [
          {
            id: 'mod-1',
            title: 'Course Lessons',
            lessons: []
          }
        ]
      };
    });

    res.json(formatted);
  } catch (err) {
    next(err);
  }
});

// DELETE /data/projects/:id
router.delete('/data/projects/:id', authenticate, requireRoles('admin'), async (req, res, next) => {
  try {
    const existing = await query('SELECT * FROM courses WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: { code: 'COURSE_NOT_FOUND', message: 'Course not found.' } });
    }
    const c = existing.rows[0];
    if (req.user.role !== 'admin' && String(c.instructor_id) !== String(req.user.id)) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You do not have permission to delete this course.' } });
    }
    await query("UPDATE courses SET status = 'archived', archived_at = now(), updated_at = now() WHERE id = $1", [req.params.id]);
    res.json({ success: true, message: 'Project archived.' });
  } catch (err) {
    next(err);
  }
});

// GET /data/assets
// F-13: the asset inventory spans every course (drafts included), so it is admin-only.
router.get('/data/assets', authenticate, requireRoles('admin'), async (_req, res, next) => {
  try {
    const result = await query(
      `SELECT da.*, c.title as course_title
       FROM data_assets da
       LEFT JOIN courses c ON c.id = da.course_id
       ORDER BY da.created_at DESC`
    );

    res.json(
      result.rows.map((a) => ({
        id: String(a.id),
        asset_name: a.asset_name,
        asset_type: a.asset_type,
        asset_size: Number(a.asset_size),
        project: a.course_title || 'General',
        created_at: a.created_at
      }))
    );
  } catch (err) {
    next(err);
  }
});

// DELETE /data/assets/:id
router.delete('/data/assets/:id', authenticate, requireRoles('admin'), async (req, res, next) => {
  try {
    await query('DELETE FROM data_assets WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'Asset deleted.' });
  } catch (err) {
    next(err);
  }
});

import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Allowlist mirrors routes/assessments.js. PDFs are the primary asset type for
// course materials; the rest are tolerated for parity with assignment uploads.
const assetFileExtensions = new Set(['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.txt', '.md', '.png', '.jpg', '.jpeg', '.webp']);
const ASSET_MAX_BYTES = 25 * 1024 * 1024; // 25 MB, matches assessments.js

// Strip any directory components and dangerous characters from a user-supplied
// filename. path.basename alone is not enough on Windows because it does not
// remove drive letters or UNC prefixes from a POSIX-style string, and multer
// hands us the raw Content-Disposition value.
function sanitizeOriginalName(name) {
  if (typeof name !== 'string') return 'file';
  const base = path.basename(name.replace(/\\/g, '/'));
  const cleaned = base.replace(/[\x00-\x1f\x7f<>:"|?*]/g, '').replace(/^\.+/, '').slice(0, 120);
  return cleaned || 'file';
}

const storage = multer.diskStorage({
  destination: function (_req, _file, cb) {
    cb(null, uploadDir);
  },
  filename: function (_req, file, cb) {
    // Stored name is fully server-generated: random UUID + vetted extension.
    // The original name is never used in the on-disk path, eliminating the
    // path-traversal vector where `../../etc/foo` in originalname could escape
    // uploadDir via path.join inside fs.createWriteStream.
    const ext = (file.originalname.toLowerCase().match(/\.[^.]+$/) || [''])[0];
    const safeExt = assetFileExtensions.has(ext) ? ext : '';
    cb(null, `${crypto.randomUUID()}${safeExt}`);
  }
});
const upload = multer({
  storage,
  limits: { files: 5, fileSize: ASSET_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    const ext = (file.originalname.toLowerCase().match(/\.[^.]+$/) || [''])[0];
    if (!assetFileExtensions.has(ext)) {
      const err = Object.assign(new Error('Unsupported file type. Allowed: PDF, Word, PowerPoint, plain text, Markdown, PNG/JPG/WebP.'), { status: 400 });
      return cb(err, false);
    }
    cb(null, true);
  }
});

// POST /upload and POST /data/upload/:fileOrId
async function uploadHandler(req, res, next) {
  try {
    const courseId = req.params.fileOrId && req.params.fileOrId !== 'undefined' ? req.params.fileOrId : null;
    let filename = `${crypto.randomUUID()}.pdf`;
    let assetSize = 0;
    let originalName = 'file.pdf';

    if (req.file) {
      filename = req.file.filename;          // server-generated UUID name
      assetSize = req.file.size;
      originalName = sanitizeOriginalName(req.file.originalname);
    }

    const ext = (originalName.match(/\.[^.]+$/) || ['.pdf'])[0].slice(1).toLowerCase();
    const result = await query(
      `INSERT INTO data_assets (course_id, asset_name, asset_type, asset_size, file_path, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [courseId, originalName, ext || 'file', assetSize, filename, req.user?.id || null]
    );

    res.status(200).json({
      success: true,
      file_id: String(result.rows[0].id),
      asset_name: originalName,
      filename
    });
  } catch (err) {
    next(err);
  }
}

// F-13: only admins may add course materials. The role check runs BEFORE multer so a
// rejected caller's file is never written to disk.
router.post('/upload', authenticate, requireRoles('admin'), upload.single('file'), uploadHandler);
router.post('/data/upload/:fileOrId', authenticate, requireRoles('admin'), upload.single('file'), uploadHandler);

// POST /data/process/:courseId and POST /courses/:courseId/ai/materials
// Really extracts text from each uploaded asset, chunks it, and stores it in
// document_chunks for full-text retrieval. Idempotent (re-indexing replaces old chunks).
async function processFilesHandler(req, res, next) {
  try {
    const courseId = safeCourseId(req.params.courseId);
    if (!courseId) {
      return res.status(400).json({ error: { code: 'INVALID_COURSE', message: 'A valid course id is required to process materials.' } });
    }
    const { processedFiles, insertedChunks, skipped } = await indexCourseAssets(courseId);
    res.json({
      success: true,
      processed_files: processedFiles,
      inserted_chunks: insertedChunks,
      skipped,
      message: processedFiles > 0
        ? `Indexed ${processedFiles} file(s) into ${insertedChunks} retrievable chunk(s).`
        : 'No indexable files for this course (none uploaded, or unsupported/unreadable).'
    });
  } catch (err) {
    next(err);
  }
}
// Indexing feeds course materials into the tutor/quiz prompts, so it is admin-only too.
router.post('/data/process/:courseId', authenticate, requireRoles('admin'), processFilesHandler);
router.post('/courses/:courseId/ai/materials', authenticate, requireRoles('admin'), processFilesHandler);

// POST /nlp/index/push/:id — indexes the course's assets and reports the real chunk count.
router.post('/nlp/index/push/:id', authenticate, requireRoles('admin'), async (req, res, next) => {
  try {
    const courseId = safeCourseId(req.params.id);
    if (!courseId) {
      return res.status(400).json({ error: { code: 'INVALID_COURSE', message: 'A valid course id is required.' } });
    }
    const { insertedChunks } = await indexCourseAssets(courseId);
    res.json({ success: true, inserted_items_count: insertedChunks });
  } catch (err) {
    next(err);
  }
});

// POST /courses/:courseId/ai/chat and POST /agent/chat/:courseId
async function chatHandler(req, res, next) {
  try {
    const { message, session_id } = req.body || {};
    const courseId = safeCourseId(req.params.courseId);

    // F-20: reject empty / non-string / oversized messages before any DB write or LLM call.
    if (typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'A non-empty message is required.' } });
    }
    if (message.length > CHAT_MESSAGE_MAX_CHARS) {
      return res.status(400).json({ error: { code: 'MESSAGE_TOO_LONG', message: `Messages are limited to ${CHAT_MESSAGE_MAX_CHARS} characters.` } });
    }

    let sessionId = session_id;
    if (sessionId) {
      // F-07: a supplied session must exist AND belong to the caller. 404 (not 403) so a
      // foreign session id cannot be probed for existence.
      const owned = UUID_RE.test(String(sessionId))
        ? await query('SELECT id FROM chat_sessions WHERE id = $1 AND user_id = $2', [sessionId, req.user.id])
        : { rows: [] };
      if (owned.rows.length === 0) {
        return res.status(404).json({ error: { code: 'SESSION_NOT_FOUND', message: 'Chat session not found.' } });
      }
    }
    if (!sessionId) {
      const sessRes = await query(
        'INSERT INTO chat_sessions (user_id, course_id) VALUES ($1, $2) RETURNING id',
        [req.user.id, courseId && courseId !== 'undefined' ? courseId : null]
      );
      sessionId = sessRes.rows[0].id;
    }

    // Save user message
    await query("INSERT INTO chat_messages (session_id, role, content) VALUES ($1, 'user', $2)", [sessionId, message || '']);

    // Load recent chat history for context (last 10 messages)
    const historyRes = await query(
      'SELECT role, content FROM chat_messages WHERE session_id = $1 ORDER BY created_at DESC LIMIT 10',
      [sessionId]
    );
    const history = historyRes.rows.reverse();

    // Load course info for system context
    let courseContext = '';
    if (courseId && courseId !== 'undefined') {
      const courseRes = await query('SELECT title, description FROM courses WHERE id = $1', [courseId]);
      if (courseRes.rows.length > 0) {
        courseContext = `\nThe student is currently enrolled in the course: "${courseRes.rows[0].title}". Course description: ${courseRes.rows[0].description || 'N/A'}.`;
      }
      // RAG: ground the tutor in the course's indexed materials (FTS over document_chunks).
      const chunks = await retrieveChunks(courseId, message, { k: 5 });
      courseContext += formatContext(chunks);
    }

    let botReply;
    try {
      const groq = await getGroqClient();

      const messages = [
        {
          role: 'system',
          content: `You are Raaed, an expert AI Tutor for the REAL_i educational platform. You are friendly, thorough, and pedagogically skilled. Provide clear, structured explanations. Use markdown formatting for readability (bold, lists, code blocks where appropriate). Keep responses concise but comprehensive.${courseContext}`
        },
        ...history.map(m => ({ role: m.role, content: m.content }))
      ];

      const completion = await groq.chat.completions.create({
        model: getGroqModel(),
        messages,
        temperature: 0.7,
        max_tokens: 800,
        top_p: 0.9,
      });

      botReply = completion.choices[0]?.message?.content || 'I apologize, I could not generate a response. Please try again.';
    } catch (llmErr) {
      console.error(`[ai/chat ${req.id || '-'}] LLM error:`, String(llmErr.message || '').slice(0, 200));
      const errMsg = (llmErr.message || '').toLowerCase();
      if (llmErr.status === 429 || errMsg.includes('429') || errMsg.includes('token') || errMsg.includes('rate_limit')) {
        botReply = "we are out of service right now";
      } else {
        botReply = `Hello! I am Raaed, your AI Tutor. I'm experiencing a temporary issue connecting to my language model. Regarding your question: "${message}", please try again in a moment. Error: ${llmErr.message}`;
      }
    }

    // Save assistant message
    await query("INSERT INTO chat_messages (session_id, role, content) VALUES ($1, 'assistant', $2)", [sessionId, botReply]);

    res.json({
      session_id: String(sessionId),
      sessionId: String(sessionId),
      role: 'assistant',
      content: botReply,
      message: botReply,
      response: botReply,
      status: 'success'
    });
  } catch (err) {
    next(err);
  }
}

router.post('/courses/:courseId/ai/chat', authenticate, chatHandler);
router.post('/agent/chat/:courseId', authenticate, chatHandler);

// DELETE /agent/session/:id
router.delete('/agent/session/:id', authenticate, async (req, res, next) => {
  try {
    // F-07: ownership-checked deletion. Admins may delete any; users only their own.
    // A missing OR not-owned session both return the same 404 so existence isn't leaked.
    const isAdmin = req.user.role === 'admin';
    const result = await query(
      'DELETE FROM chat_sessions WHERE id = $1 AND (user_id = $2 OR $3)',
      [req.params.id, req.user.id, isAdmin]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: { code: 'SESSION_NOT_FOUND', message: 'Chat session not found.' } });
    }
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// POST /courses/:courseId/ai/quizzes and POST /agent/quiz/:courseId
async function generateQuizHandler(req, res, next) {
  try {
    const { topic = 'General Platform', count = 5, num_questions = 5, title } = req.body || {};
    const numQ = count || num_questions || 5;
    const courseId = safeCourseId(req.params.courseId);

    let courseContext = '';
    if (courseId && courseId !== 'undefined') {
      const courseRes = await query('SELECT title, description FROM courses WHERE id = $1', [courseId]);
      if (courseRes.rows.length > 0) {
        courseContext = `\nContext: This quiz is for the course "${courseRes.rows[0].title}". ${courseRes.rows[0].description || ''}`;
      }
      // RAG: draw questions from the course's indexed materials when available.
      const chunks = await retrieveChunks(courseId, topic, { k: 6 });
      courseContext += formatContext(chunks);
    }

    const groq = await getGroqClient();

    const prompt = `Generate a multiple choice quiz about "${topic}". Create exactly ${numQ} questions.${courseContext}
Respond ONLY with a valid JSON object of the form {"questions": [...]}, where each item has this exact structure:
{
  "id": "unique-string-id",
  "question": "The question text",
  "options": ["Option A", "Option B", "Option C", "Option D"],
  "correct_answer": "The exact string of the correct option",
  "correctIndex": 0,
  "explanation": "Brief explanation of why the correct answer is right, AND a hint explaining why the other options are wrong."
}
correctIndex is the 0-based integer index of the correct option. IMPORTANT: Randomize the correctIndex for each question so that the correct answer is NOT always the first option! Do not include comments or extra keys.`;

    const completion = await groq.chat.completions.create({
      model: getGroqModel(),
      messages: [
        { role: 'system', content: 'You are an expert exam writer. Respond ONLY with valid JSON.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.5,
      response_format: { type: 'json_object' }
    });

    let quizQuestions = [];
    try {
      const rawOutput = completion.choices[0]?.message?.content || '[]';
      const parsed = JSON.parse(rawOutput);
      quizQuestions = Array.isArray(parsed) ? parsed : (parsed.questions || Object.values(parsed)[0] || []);
      
      quizQuestions = quizQuestions.slice(0, numQ).map((q, i) => {
        const rawOptions = Array.isArray(q.options) && q.options.length > 0 ? q.options.slice() : ['A', 'B', 'C', 'D'];
        const rawIndex = Number.isInteger(q.correctIndex) ? q.correctIndex : 0;
        const correctValue = rawOptions[rawIndex] !== undefined ? rawOptions[rawIndex] : (q.correct_answer || rawOptions[0]);
        // Shuffle to counter LLM positional bias (model skews correct answer toward option B).
        for (let j = rawOptions.length - 1; j > 0; j--) {
          const k = crypto.randomInt(0, j + 1);
          [rawOptions[j], rawOptions[k]] = [rawOptions[k], rawOptions[j]];
        }
        const newIndex = Math.max(0, rawOptions.indexOf(correctValue));
        return {
          id: q.id || `q-${i}`,
          question: q.question || 'Missing question?',
          options: rawOptions,
          correct_answer: rawOptions[newIndex],
          correctIndex: newIndex,
          explanation: q.explanation || 'No explanation provided.'
        };
      });
    } catch (parseErr) {
      console.error('[ai/quiz] failed to parse model output:', String(parseErr.message || '').slice(0, 200));
      throw new Error('Failed to generate valid quiz format');
    }

    // The answer key NEVER leaves the server. Clients submit answers to
    // POST /ai/quizzes/:quizId/grade and receive per-question isCorrect + explanation
    // only AFTER submission. Explanations are withheld pre-submission so the correct
    // option cannot be inferred from hint text.
    const publicQuestions = quizQuestions.map((q) => ({
      id: q.id,
      question: q.question,
      options: q.options
    }));

    // Persist the answer key server-side (never returned to the browser) so grading
    // survives a restart. Swept after the TTL.
    const quizId = `aiq-${crypto.randomUUID()}`;
    await query(
      `INSERT INTO ai_quiz_keys (quiz_id, course_id, topic, questions, user_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [quizId, courseId, topic, JSON.stringify(quizQuestions.map((q) => ({
        id: q.id,
        correctIndex: q.correctIndex,
        explanation: q.explanation || ''
      }))), req.user.id]
    );
    sweepAiQuizKeys();

    res.status(201).json({
      success: true,
      id: quizId,
      quizId,
      title: title || `Quiz: ${topic}`,
      quiz: {
        topic,
        questions: publicQuestions
      },
      questions: publicQuestions
    });
  } catch (err) {
    next(err);
  }
}
router.post('/courses/:courseId/ai/quizzes', authenticate, generateQuizHandler);
router.post('/agent/quiz/:courseId', authenticate, generateQuizHandler);

// POST /ai/quizzes/:quizId/grade — server-side grading of an AI practice quiz.
// Accepts { answers: { [questionId]: selectedIndex } } (or an array) and returns the
// score without ever exposing the answer key to the client.
router.post('/ai/quizzes/:quizId/grade', authenticate, async (req, res, next) => {
  try {
    // F-06: the quiz must belong to the caller (legacy rows without an owner stay gradable),
    // and it is graded exactly once. The first submission is the authoritative score; later
    // calls replay it, so a student cannot learn the key and then re-grade with perfect answers.
    const keyRes = await query(
      `SELECT questions, graded_result FROM ai_quiz_keys
       WHERE quiz_id = $1 AND (user_id IS NULL OR user_id = $2)
         AND created_at >= now() - make_interval(hours => $3)`,
      [req.params.quizId, req.user.id, AI_QUIZ_TTL_HOURS]
    );
    if (keyRes.rows.length === 0) {
      return res.status(404).json({ error: { code: 'QUIZ_NOT_FOUND', message: 'Quiz expired or not found; please generate a new one.' } });
    }
    if (keyRes.rows[0].graded_result) {
      return res.json(keyRes.rows[0].graded_result);
    }
    const entry = { questions: keyRes.rows[0].questions };
    const raw = (req.body && req.body.answers) || {};
    const pick = (id) => (Array.isArray(raw) ? (raw.find((a) => (a.questionId || a.id) === id) || {}).value : raw[id]);

    let correct = 0;
    const detail = entry.questions.map((q) => {
      const selected = pick(q.id);
      const isCorrect = selected !== undefined && selected !== null && Number(selected) === Number(q.correctIndex);
      if (isCorrect) correct += 1;
      // Safe to reveal AFTER submission: the client has already locked in answers.
      return {
        id: q.id,
        isCorrect,
        correctIndex: Number(q.correctIndex),
        explanation: q.explanation || ''
      };
    });
    const total = entry.questions.length;
    const percentage = total > 0 ? Math.round((correct / total) * 100) : 0;
    const payload = { success: true, quizId: req.params.quizId, correct, total, score: percentage, detail };

    // Compare-and-set so two concurrent first submissions cannot both become authoritative.
    const stored = await query(
      `UPDATE ai_quiz_keys SET user_id = $2, graded_at = now(), graded_result = $3
       WHERE quiz_id = $1 AND graded_result IS NULL
       RETURNING graded_result`,
      [req.params.quizId, req.user.id, JSON.stringify(payload)]
    );
    if (stored.rows.length === 0) {
      const again = await query('SELECT graded_result FROM ai_quiz_keys WHERE quiz_id = $1', [req.params.quizId]);
      return res.json(again.rows[0]?.graded_result || payload);
    }
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

// GET /agent/guidelines/active/:id
router.get('/agent/guidelines/active/:id', authenticate, async (req, res, next) => {
  try {
    const result = await query(
      "SELECT * FROM ai_guidelines WHERE status = 'active' AND (course_id = $1 OR scope = 'global')",
      [req.params.id]
    );
    res.json(result.rows.map((g) => ({ task_id: String(g.id), directive: g.content, status: 'active' })));
  } catch (err) {
    next(err);
  }
});

// GET /agent/quizzes/:id
router.get('/agent/quizzes/:id', authenticate, async (req, res, next) => {
  try {
    const courseId = safeCourseId(req.params.id);
    if (!courseId) {
      return res.status(400).json({ error: { code: 'INVALID_COURSE', message: 'Invalid course id.' } });
    }
    const isStaff = req.user.role === 'admin' || req.user.role === 'instructor';
    // F-04: students must be enrolled to read a course's quizzes.
    if (!isStaff) {
      const enr = await query(
        "SELECT 1 FROM enrollments WHERE student_id = $1 AND course_id = $2 AND status IN ('enrolled','completed')",
        [req.user.id, courseId]
      );
      if (enr.rows.length === 0) {
        return res.status(403).json({ error: { code: 'ENROLLMENT_REQUIRED', message: 'Enroll in this course to access its quizzes.' } });
      }
    }
    const result = await query(
      "SELECT id, title, time_limit_seconds, questions FROM assessments WHERE course_id = $1 AND status = 'published'",
      [courseId]
    );
    // F-03: never expose answer keys / grading metadata to students. Staff get the full bank.
    const publicQuestion = (q) => ({
      id: q.id,
      type: q.type || 'mcq',
      prompt: q.prompt || q.text || q.question,
      options: q.options,
      points: q.points
    });
    res.json(result.rows.map((a) => ({
      id: String(a.id),
      title: a.title,
      time_limit_seconds: a.time_limit_seconds,
      questions: (typeof a.questions === 'string' ? JSON.parse(a.questions) : (a.questions || [])).map(isStaff ? (q) => q : publicQuestion)
    })));
  } catch (err) {
    next(err);
  }
});

// POST /agent/quizzes/results
// F-06: the score is NEVER taken from the client. It comes from the caller's own
// server-graded AI quiz (POST /ai/quizzes/:quizId/grade). Each graded quiz can be claimed
// by one task_id, so one good result cannot be replayed across several tasks. The client's
// `score`, `total` and `student_id` fields are ignored.
router.post('/agent/quizzes/results', authenticate, async (req, res, next) => {
  try {
    const { task_id, quiz_id, answers } = req.body || {};
    const taskId = String(task_id || 'general-task').slice(0, 200);
    const quizId = typeof quiz_id === 'string' && quiz_id ? quiz_id.slice(0, 64) : null;

    const claimed = await query(
      `UPDATE ai_quiz_keys SET claimed_task_id = $2
       WHERE quiz_id = (
         SELECT quiz_id FROM ai_quiz_keys
         WHERE user_id = $1 AND graded_at IS NOT NULL
           AND (claimed_task_id IS NULL OR claimed_task_id = $2)
           AND ($3::text IS NULL OR quiz_id = $3)
         ORDER BY graded_at DESC LIMIT 1
         FOR UPDATE SKIP LOCKED)
       RETURNING graded_result`,
      [req.user.id, taskId, quizId]
    );
    if (claimed.rows.length === 0) {
      return res.status(409).json({ error: { code: 'NO_GRADED_QUIZ', message: 'Complete and submit a quiz for grading before recording a result.' } });
    }
    const graded = claimed.rows[0].graded_result;
    const t = Math.max(1, Math.floor(Number(graded.total) || 1));
    const s = Math.max(0, Math.min(t, Math.floor(Number(graded.correct) || 0)));
    const safeAnswers = JSON.stringify(answers || {}).length <= 50000 ? answers || {} : {};

    const result = await query(
      `INSERT INTO quiz_results (student_id, task_id, score, total, answers)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (student_id, task_id)
       DO UPDATE SET score = EXCLUDED.score, total = EXCLUDED.total, answers = EXCLUDED.answers
       RETURNING *`,
      [req.user.id, taskId, s, t, JSON.stringify(safeAnswers)]
    );

    res.json({ success: true, result: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /agent/quizzes/completed/:id
router.get('/agent/quizzes/completed/:id', authenticate, async (req, res, next) => {
  try {
    // F-05: scope to the caller. Staff may query a specific student; everyone else only themselves.
    const isStaff = req.user.role === 'admin' || req.user.role === 'instructor';
    const studentId = isStaff && UUID_RE.test(String(req.params.id)) ? String(req.params.id) : req.user.id;
    const results = await query(
      'SELECT task_id, score FROM quiz_results WHERE student_id = $1',
      [studentId]
    );
    res.json({ completed_tasks: results.rows.map((r) => ({ task_id: r.task_id, score: r.score })) });
  } catch (err) {
    next(err);
  }
});

// POST /admin/task/create — administrative Command Chat. Reads the request, answers it
// using real platform data, and persists the exchange so the Execution Logs panel has a
// record. No fabricated success.
router.post('/admin/task/create', authenticate, requireRoles('admin'), async (req, res, next) => {
  try {
    const { request, message, session_id } = req.body || {};
    const prompt = String(request || message || '').trim();
    if (!prompt) {
      return res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'A request is required.' } });
    }

    // Gather live platform facts to ground the answer.
    const [usersRes, coursesRes, enrollRes, assessRes, subRes, liveRes, guideRes] = await Promise.all([
      query("SELECT COUNT(*) FILTER (WHERE role='student') AS students, COUNT(*) FILTER (WHERE role='admin') AS admins, COUNT(*) AS total FROM users WHERE deleted_at IS NULL"),
      query("SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status='published') AS published FROM courses WHERE status != 'archived'"),
      query("SELECT COUNT(*) AS total FROM enrollments WHERE status IN ('enrolled','completed')"),
      query("SELECT COUNT(*) AS total FROM assessments WHERE status='published'"),
      query("SELECT COUNT(*) AS total, ROUND(AVG(grading_score)) AS avg_score FROM submissions WHERE grading_score IS NOT NULL"),
      query("SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status='live') AS live FROM live_sessions"),
      query("SELECT COUNT(*) AS active FROM ai_guidelines WHERE status='active'")
    ]);

    const facts = {
      totalUsers: Number(usersRes.rows[0].total),
      students: Number(usersRes.rows[0].students),
      admins: Number(usersRes.rows[0].admins),
      courses: Number(coursesRes.rows[0].total),
      publishedCourses: Number(coursesRes.rows[0].published),
      enrollments: Number(enrollRes.rows[0].total),
      publishedAssessments: Number(assessRes.rows[0].total),
      submissions: Number(subRes.rows[0].total),
      averageScore: subRes.rows[0].avg_score !== null ? Number(subRes.rows[0].avg_score) : null,
      liveSessions: Number(liveRes.rows[0].live),
      totalSessions: Number(liveRes.rows[0].total),
      activeGuidelines: Number(guideRes.rows[0].active)
    };

    let answer;
    try {
      const groq = await getGroqClient();
      const completion = await groq.chat.completions.create({
        model: getGroqModel(),
        messages: [
          {
            role: 'system',
            content: `You are the REAL_i administrative assistant. Answer concisely using ONLY the platform metrics provided. Current metrics: ${JSON.stringify(facts)}. If a question cannot be answered from these metrics, say so plainly.`
          },
          { role: 'user', content: prompt }
        ],
        temperature: 0.4,
        max_tokens: 512
      });
      answer = completion.choices[0]?.message?.content?.trim();
    } catch (llmErr) {
      answer = null;
    }

    if (!answer) {
      answer = `Platform snapshot — ${facts.students} students and ${facts.admins} admins (${facts.totalUsers} users total); ${facts.publishedCourses} published of ${facts.courses} courses; ${facts.enrollments} active enrollments; ${facts.publishedAssessments} published assessments; average submission score ${facts.averageScore ?? 'n/a'}; ${facts.liveSessions} live of ${facts.totalSessions} sessions; ${facts.activeGuidelines} active guidelines.`;
    }

    let taskId = null;
    try {
      const saved = await query(
        `INSERT INTO admin_tasks (requested_by, request, response, status) VALUES ($1, $2, $3, 'completed') RETURNING id`,
        [req.user.id, prompt, answer]
      );
      taskId = String(saved.rows[0].id);
    } catch (dbErr) {
      console.error('Failed to persist admin task:', dbErr.message);
    }

    res.json({
      status: 'success',
      task_id: taskId || `task-${crypto.randomUUID().slice(0, 8)}`,
      session_id: session_id || null,
      message: answer,
      response: answer,
      content: answer,
      metrics: facts
    });
  } catch (err) {
    next(err);
  }
});

export default router;
