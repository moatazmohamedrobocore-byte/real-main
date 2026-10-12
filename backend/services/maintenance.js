import { query } from '../db/pool.js';

// Periodic housekeeping so unbounded tables don't grow forever (audit #12) and
// expired AI quiz keys are reclaimed even if no write triggers the inline sweep.
//
// CHAT_RETENTION_DAYS: how long chat sessions/messages are kept (default 90).
// Set to 0 to disable chat pruning.
const CHAT_RETENTION_DAYS = Number(process.env.CHAT_RETENTION_DAYS ?? 90);
const QUIZ_KEY_TTL_HOURS = 2;

export async function pruneChatHistory() {
  if (!Number.isFinite(CHAT_RETENTION_DAYS) || CHAT_RETENTION_DAYS <= 0) return { sessions: 0, messages: 0 };
  const cutoff = `${CHAT_RETENTION_DAYS} days`;
  // Messages first (some may belong to sessions retained via course links), then sessions.
  const msgs = await query(
    `DELETE FROM chat_messages WHERE created_at < now() - $1::interval`,
    [cutoff]
  );
  const sessions = await query(
    `DELETE FROM chat_sessions WHERE created_at < now() - $1::interval`,
    [cutoff]
  );
  return { messages: msgs.rowCount || 0, sessions: sessions.rowCount || 0 };
}

export async function sweepExpiredQuizKeys() {
  const res = await query(
    `DELETE FROM ai_quiz_keys WHERE created_at < now() - make_interval(hours => $1)`,
    [QUIZ_KEY_TTL_HOURS]
  );
  return { keys: res.rowCount || 0 };
}

export async function runMaintenance() {
  try {
    const chat = await pruneChatHistory();
    const quiz = await sweepExpiredQuizKeys();
    if (chat.messages || chat.sessions || quiz.keys) {
      console.log(`[maintenance] pruned chat messages=${chat.messages} sessions=${chat.sessions}; quiz keys=${quiz.keys}`);
    }
  } catch (err) {
    console.error('[maintenance] job failed:', err.message);
  }
}

export function startMaintenanceScheduler() {
  // Hourly. unref() so it never holds the process open.
  runMaintenance();
  return setInterval(runMaintenance, 60 * 60 * 1000).unref?.();
}
