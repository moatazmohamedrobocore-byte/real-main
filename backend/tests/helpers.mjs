import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BACKEND_DIR = path.resolve(__dirname, '..');

export const TEST_PORT = Number(process.env.TEST_PORT || 3101);
export const BASE = `http://localhost:${TEST_PORT}/v1`;

// Throwaway secrets for the isolated test server only — never real credentials.
export const TEST_JWT_ACCESS = 'test-only-access-secret-0123456789abcdef0123456789';
export const TEST_JWT_REFRESH = 'test-only-refresh-secret-0123456789abcdef0123456789';

function deriveTestDatabaseUrl() {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const envPath = path.join(BACKEND_DIR, '.env');
  const env = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const m = env.match(/^DATABASE_URL=(.*)$/m);
  if (!m) throw new Error('TEST_DATABASE_URL not set and DATABASE_URL not found in backend/.env');
  return m[1].trim().replace(/\/real_i(\?|$)/, '/real_i_test$1');
}
export const TEST_DATABASE_URL = deriveTestDatabaseUrl();

let fixturePool;
export function db() {
  if (!fixturePool) fixturePool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  return fixturePool;
}

// Wipe all data tables for a clean, isolated run (test DB only).
export async function resetDb() {
  await db().query(`
    DO $$ DECLARE r RECORD; BEGIN
      FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
        EXECUTE 'TRUNCATE TABLE public.' || quote_ident(r.tablename) || ' RESTART IDENTITY CASCADE';
      END LOOP;
    END $$;
  `);
}

let child;
export async function startServer() {
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(TEST_PORT),
    DATABASE_URL: TEST_DATABASE_URL,
    JWT_ACCESS_SECRET: TEST_JWT_ACCESS,
    JWT_REFRESH_SECRET: TEST_JWT_REFRESH,
    JWT_SECRET: TEST_JWT_ACCESS,
    CORS_ORIGIN: '',
    CHAT_RETENTION_DAYS: '0'
  };
  child = spawn('node', ['server.js'], { cwd: BACKEND_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const pipe = (stream, tag) => stream.on('data', (d) => { if (process.env.TEST_VERBOSE) process.stderr.write(`[${tag}] ${d}`); });
  pipe(child.stdout, 'server');
  pipe(child.stderr, 'server:err');

  const deadline = Date.now() + 25000;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://localhost:${TEST_PORT}/health`);
      if (r.ok) return;
    } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`test server did not become healthy: ${lastErr?.message || 'timeout'}`);
}

export async function stopServer() {
  if (child) { try { child.kill('SIGTERM'); } catch {} child = null; }
  if (fixturePool) { await fixturePool.end().catch(() => {}); fixturePool = null; }
}

export async function api(p, { method = 'GET', token, body, headers: extra } = {}) {
  const headers = { ...(extra || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, body: json, headers: res.headers };
}

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

// Register a synthetic student, optionally promoting to admin/instructor via the fixture DB.
export async function makeUser(role = 'student', password = 'TestPassw0rd!123') {
  const email = `${role}.${uniq()}@test.local`;
  const name = `${role}_${uniq()}`;
  const reg = await api('/auth/register', { method: 'POST', body: { name, email, password } });
  if (role !== 'student') {
    await db().query('UPDATE users SET role = $1 WHERE email = $2', [role, email]);
  }
  const login = await api('/auth/login', { method: 'POST', body: { email, password } });
  const token = login.body?.accessToken || login.body?.token;
  const id = login.body?.user?.id || login.body?.id || reg.body?.user?.id;
  return { id, email, name, password, role, token };
}

export async function login(email, password) {
  const r = await api('/auth/login', { method: 'POST', body: { email, password } });
  return { token: r.body?.accessToken || r.body?.token, status: r.status, body: r.body };
}
