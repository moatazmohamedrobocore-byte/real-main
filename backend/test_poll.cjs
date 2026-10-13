const { Pool } = require('pg');
require('dotenv').config({ path: 'backend/.env' });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function run() {
  try {
    const res = await pool.query("SELECT id, provider_room_id FROM live_sessions WHERE status = 'live' ORDER BY created_at DESC LIMIT 1");
    if (res.rows.length === 0) {
      console.log('No live sessions');
      return;
    }
    const session = res.rows[0];
    console.log('Session:', session);

    let sessionId = session.provider_room_id; // Simulating roomSlug passed from frontend

    if (sessionId && sessionId.length !== 36) {
      const sessRes = await pool.query('SELECT id FROM live_sessions WHERE provider_room_id = $1', [sessionId]);
      if (sessRes.rows.length > 0) sessionId = sessRes.rows[0].id;
    }
    
    console.log('Resolved UUID:', sessionId);

    const sessRes = await pool.query('SELECT course_id FROM live_sessions WHERE id = $1', [sessionId]);
    if (sessRes.rows.length === 0) {
      console.log('Session not found by UUID');
      return;
    }

    const courseId = sessRes.rows[0].course_id;
    console.log('Course ID:', courseId);

    // Get an admin user
    const userRes = await pool.query("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
    const userId = userRes.rows[0].id;

    // Simulate insert
    const insertRes = await pool.query(
      `INSERT INTO polls (session_id, course_id, created_by, question, response_type, options, status, opens_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'open', now())
       RETURNING *`,
      [sessionId, courseId, userId, "Test Poll?", "single_choice", JSON.stringify(["A", "B"])]
    );

    console.log('Inserted Poll:', insertRes.rows[0]);

  } catch (err) {
    console.error('Error:', err);
  } finally {
    pool.end();
  }
}

run();
