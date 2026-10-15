// Centralized Groq LLM client + model resolution.
// Replaces the previously duplicated inline `new Groq({apiKey})` + hard-coded
// model string at four call sites (routes/data.js x3, routes/meetings.js x1).
//
// Model is env-driven (GROQ_MODEL) with a safe default. The default matches the
// string the platform has been running on; override per environment if Groq's
// catalog changes. A missing GROQ_API_KEY fails closed with a 503-shaped error
// instead of throwing an opaque auth failure deep inside a request.

const DEFAULT_MODEL = process.env.GROQ_MODEL_DEFAULT || 'qwen/qwen3.8-27b';

export function getGroqModel() {
  return process.env.GROQ_MODEL || DEFAULT_MODEL;
}

export function groqKeyPresent() {
  const key = process.env.GROQ_API_KEY;
  return Boolean(key) && key !== 'replace-with-groq-api-key';
}

export function requireGroqKey() {
  const key = process.env.GROQ_API_KEY;
  if (!key || key === 'replace-with-groq-api-key') {
    const err = new Error('GROQ_API_KEY is not configured on the server.');
    err.status = 503;
    err.code = 'LLM_UNCONFIGURED';
    throw err;
  }
  return key;
}

export async function getGroqClient() {
  const key = requireGroqKey();
  const Groq = (await import('groq-sdk')).default;
  return new Groq({ apiKey: key });
}

export function providerUnavailable() {
  return Object.assign(new Error('AI service is temporarily unavailable. Please try again later.'), {
    status: 503,
    code: 'AI_UNAVAILABLE',
    expose: true
  });
}
