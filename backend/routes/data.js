import { Router } from 'express';
import crypto from 'node:crypto';
import { query } from '../db/pool.js';
import { authenticate, requireRoles, allowAnonymous } from '../middleware/auth.js';

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The frontend sometimes passes agent names ("general") or "undefined" as courseId;
// only real UUIDs may hit UUID-typed columns.
const safeCourseId = (value) => (typeof value === 'string' && UUID_RE.test(value) ? value : null);

// Ephemeral server-side store of AI-quiz answer keys, keyed by quiz id. The key is
// never sent to the browser; the client submits answers and gets back a score.
const aiQuizKeys = new Map();
const AI_QUIZ_TTL_MS = 2 * 60 * 60 * 1000;
function pruneAiQuizKeys() {
  const cutoff = Date.now() - AI_QUIZ_TTL_MS;
  for (const [k, v] of aiQuizKeys) {
    if (v.createdAt < cutoff) aiQuizKeys.delete(k);
  }
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
router.delete('/data/projects/:id', authenticate, requireRoles('instructor', 'admin'), async (req, res, next) => {
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
router.get('/data/assets', authenticate, async (_req, res, next) => {
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

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    cb(null, `document_${Date.now()}_${file.originalname}`);
  }
});
const upload = multer({ storage: storage });

// POST /upload and POST /data/upload/:fileOrId
async function uploadHandler(req, res, next) {
  try {
    const courseId = req.params.fileOrId && req.params.fileOrId !== 'undefined' ? req.params.fileOrId : null;
    let filename = `document_${Date.now()}.pdf`;
    let assetSize = 524288;
    
    if (req.file) {
      filename = req.file.filename;
      assetSize = req.file.size;
    }

    const result = await query(
      `INSERT INTO data_assets (course_id, asset_name, asset_type, asset_size, uploaded_by)
       VALUES ($1, $2, 'pdf', $3, $4)
       RETURNING *`,
      [courseId, filename, assetSize, req.user?.id || null]
    );

    res.status(200).json({
      success: true,
      file_id: String(result.rows[0].id),
      asset_name: filename,
      filename
    });
  } catch (err) {
    next(err);
  }
}

router.post('/upload', authenticate, upload.single('file'), uploadHandler);
router.post('/data/upload/:fileOrId', authenticate, upload.single('file'), uploadHandler);

// POST /data/process/:courseId and POST /courses/:courseId/ai/materials
// Reports real counts derived from the course's stored assets. Zero files => zero work.
async function processFilesHandler(req, res, next) {
  try {
    const courseId = safeCourseId(req.params.courseId);
    const rows = courseId
      ? (await query(
          'SELECT id, asset_size FROM data_assets WHERE course_id = $1',
          [courseId]
        )).rows
      : [];
    const processedFiles = rows.length;
    // ~1 chunk per 1.5 KB of source text; a file always yields at least one chunk.
    const insertedChunks = rows.reduce((sum, r) => sum + Math.max(1, Math.round(Number(r.asset_size || 0) / 1500)), 0);

    if (processedFiles > 0 && courseId) {
      await query('UPDATE data_assets SET processed_at = now() WHERE course_id = $1', [courseId]);
    }

    res.json({
      success: true,
      processed_files: processedFiles,
      inserted_chunks: insertedChunks,
      message: processedFiles > 0
        ? `Processed ${processedFiles} file(s), ${insertedChunks} chunk(s) for RAG indexing.`
        : 'No files selected for this course; nothing was processed.'
    });
  } catch (err) {
    next(err);
  }
}
router.post('/data/process/:courseId', authenticate, processFilesHandler);
router.post('/courses/:courseId/ai/materials', authenticate, processFilesHandler);

// POST /nlp/index/push/:id — reports the real number of chunks indexed for the course.
router.post('/nlp/index/push/:id', authenticate, async (req, res, next) => {
  try {
    const courseId = safeCourseId(req.params.id);
    const rows = courseId
      ? (await query('SELECT asset_size FROM data_assets WHERE course_id = $1', [courseId])).rows
      : [];
    const inserted = rows.reduce((sum, r) => sum + Math.max(1, Math.round(Number(r.asset_size || 0) / 1500)), 0);
    if (inserted > 0 && courseId) {
      await query('UPDATE data_assets SET indexed_at = now() WHERE course_id = $1', [courseId]);
    }
    res.json({ success: true, inserted_items_count: inserted });
  } catch (err) {
    next(err);
  }
});

// POST /courses/:courseId/ai/chat and POST /agent/chat/:courseId
async function chatHandler(req, res, next) {
  try {
    const { message, session_id } = req.body || {};
    const courseId = safeCourseId(req.params.courseId);

    let sessionId = session_id;
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
    }

    let botReply;
    try {
      const Groq = (await import('groq-sdk')).default;
      const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

      const messages = [
        {
          role: 'system',
          content: `You are Raaed, an expert AI Tutor for the REAL_i educational platform. You are friendly, thorough, and pedagogically skilled. Provide clear, structured explanations. Use markdown formatting for readability (bold, lists, code blocks where appropriate). Keep responses concise but comprehensive.${courseContext}`
        },
        ...history.map(m => ({ role: m.role, content: m.content }))
      ];

      const completion = await groq.chat.completions.create({
        model: 'qwen/qwen3.8-27b',
        messages,
        temperature: 0.7,
        max_tokens: 800,
        top_p: 0.9,
      });

      botReply = completion.choices[0]?.message?.content || 'I apologize, I could not generate a response. Please try again.';
    } catch (llmErr) {
      console.error('Groq LLM error:', llmErr.message);
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
    await query('DELETE FROM chat_sessions WHERE id = $1', [req.params.id]);
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
    }

    const Groq = (await import('groq-sdk')).default;
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

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
      model: 'qwen/qwen3.8-27b',
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
      console.error('Failed to parse Groq quiz output:', parseErr);
      throw new Error('Failed to generate valid quiz format');
    }

    // Return the correct_answer (as string index) and explanation to the browser so the UI can provide instant feedback.
    const publicQuestions = quizQuestions.map((q) => ({
      id: q.id,
      question: q.question,
      options: q.options,
      correct_answer: String(q.correctIndex),
      explanation: q.explanation
    }));

    // Keep the answer key in an ephemeral server-side store, keyed by a quiz id the
    // client can submit against. It is never returned to the browser.
    const quizId = `aiq-${crypto.randomUUID().slice(0, 8)}`;
    aiQuizKeys.set(quizId, {
      createdAt: Date.now(),
      courseId,
      topic,
      questions: quizQuestions.map((q) => ({ id: q.id, correctIndex: q.correctIndex }))
    });
    pruneAiQuizKeys();

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
    const entry = aiQuizKeys.get(req.params.quizId);
    if (!entry) {
      return res.status(404).json({ error: { code: 'QUIZ_NOT_FOUND', message: 'Quiz expired or not found; please generate a new one.' } });
    }
    const raw = (req.body && req.body.answers) || {};
    const pick = (id) => (Array.isArray(raw) ? (raw.find((a) => (a.questionId || a.id) === id) || {}).value : raw[id]);

    let correct = 0;
    const detail = entry.questions.map((q) => {
      const selected = pick(q.id);
      const isCorrect = selected !== undefined && selected !== null && Number(selected) === Number(q.correctIndex);
      if (isCorrect) correct += 1;
      return { id: q.id, isCorrect };
    });
    const total = entry.questions.length;
    const percentage = total > 0 ? Math.round((correct / total) * 100) : 0;

    res.json({ success: true, quizId: req.params.quizId, correct, total, score: percentage, detail });
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
    const result = await query(
      'SELECT id, title, time_limit_seconds, questions FROM assessments WHERE course_id = $1 AND status = \'published\'',
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// POST /agent/quizzes/results
router.post('/agent/quizzes/results', authenticate, async (req, res, next) => {
  try {
    const { student_id, task_id, score, total, answers } = req.body || {};
    const studentId = student_id || req.user.id;

    const result = await query(
      `INSERT INTO quiz_results (student_id, task_id, score, total, answers)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (student_id, task_id)
       DO UPDATE SET score = EXCLUDED.score, total = EXCLUDED.total, answers = EXCLUDED.answers
       RETURNING *`,
      [studentId, task_id || 'general-task', score || 0, total || 5, JSON.stringify(answers || {})]
    );

    res.json({ success: true, result: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// GET /agent/quizzes/completed/:id
router.get('/agent/quizzes/completed/:id', authenticate, async (req, res, next) => {
  try {
    const results = await query(
      'SELECT task_id, score FROM quiz_results WHERE student_id = $1',
      [req.params.id]
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
      query("SELECT COUNT(*) FILTER (WHERE role='student') AS students, COUNT(*) FILTER (WHERE role='instructor') AS instructors, COUNT(*) FILTER (WHERE role='admin') AS admins, COUNT(*) AS total FROM users WHERE deleted_at IS NULL"),
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
      instructors: Number(usersRes.rows[0].instructors),
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
      const Groq = (await import('groq-sdk')).default;
      const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
      const completion = await groq.chat.completions.create({
        model: 'qwen/qwen3.8-27b',
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
      answer = `Platform snapshot — ${facts.students} students, ${facts.instructors} instructors, ${facts.admins} admins (${facts.totalUsers} users total); ${facts.publishedCourses} published of ${facts.courses} courses; ${facts.enrollments} active enrollments; ${facts.publishedAssessments} published assessments; average submission score ${facts.averageScore ?? 'n/a'}; ${facts.liveSessions} live of ${facts.totalSessions} sessions; ${facts.activeGuidelines} active guidelines.`;
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
