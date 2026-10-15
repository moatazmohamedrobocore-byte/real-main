import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { startServer, stopServer, resetDb, makeUser, api, db } from './helpers.mjs';

before(async () => { await resetDb(); await startServer(); });
after(async () => { await stopServer(); });

const OLD_PW = 'TestPassw0rd!123';
const NEW_PW = 'RotatedPassw0rd!987';

const pwHash = async (email) => (await db().query('SELECT password_hash FROM users WHERE email = $1', [email])).rows[0]?.password_hash;
const roleOf = async (id) => (await db().query('SELECT role FROM users WHERE id = $1', [id])).rows[0]?.role;

test('F-18: changing your own password without proving the current one is refused', async () => {
  const stu = await makeUser('student');
  const before = await pwHash(stu.email);

  const r = await api(`/users/${stu.id}/profile`, { method: 'PUT', token: stu.token, body: { password: NEW_PW } });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body?.error?.code, 'CURRENT_PASSWORD_REQUIRED');
  assert.equal(await pwHash(stu.email), before, 'F-18: password hash untouched without current-password proof');

  // the old password still authenticates — nothing was silently overwritten
  const relogin = await api('/auth/login', { method: 'POST', body: { email: stu.email, password: OLD_PW } });
  assert.equal(relogin.status, 200);
});

test('F-18: a wrong current password is rejected and the account stays usable', async () => {
  const stu = await makeUser('student');
  const before = await pwHash(stu.email);

  const r = await api(`/users/${stu.id}/profile`, {
    method: 'PUT', token: stu.token,
    body: { password: NEW_PW, currentPassword: 'NotTheRealPassword!1' }
  });
  assert.equal(r.status, 401, JSON.stringify(r.body));
  assert.equal(r.body?.error?.code, 'INVALID_CURRENT_PASSWORD');
  assert.equal(await pwHash(stu.email), before);
  assert.equal((await api('/auth/me', { token: stu.token })).status, 200, 'a failed attempt must not lock the live session');
});

test('F-18: a correct current password rotates it and revokes every live session', async () => {
  const stu = await makeUser('student');
  const staleAccess = stu.token;
  const staleRefresh = (await api('/auth/login', { method: 'POST', body: { email: stu.email, password: OLD_PW } })).body.refreshToken;

  const r = await api(`/users/${stu.id}/profile`, {
    method: 'PUT', token: stu.token,
    body: { password: NEW_PW, currentPassword: OLD_PW }
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  assert.equal((await api('/auth/login', { method: 'POST', body: { email: stu.email, password: OLD_PW } })).status, 401, 'old password no longer logs in');
  assert.equal((await api('/auth/login', { method: 'POST', body: { email: stu.email, password: NEW_PW } })).status, 200, 'new password logs in');

  // F-18 core: the pre-change bearer token is dead even though it has not expired.
  const me = await api('/auth/me', { token: staleAccess });
  assert.equal(me.status, 401, JSON.stringify(me.body));
  assert.equal(me.body?.error?.code, 'SESSION_REVOKED');

  const refreshed = await api('/auth/refresh', { method: 'POST', body: { refreshToken: staleRefresh } });
  assert.equal(refreshed.status, 401, 'F-18: revoked refresh token cannot mint a new session');
});

test('F-18: a student cannot escalate their own role or write privileged fields', async () => {
  const stu = await makeUser('student');

  const r = await api(`/users/${stu.id}/profile`, {
    method: 'PATCH', token: stu.token,
    body: { name: stu.name, role: 'admin', email: 'pwn@test.local', password_hash: 'x', tokens_valid_after: null, deleted_at: null }
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.role, 'student', 'role in the response is unchanged');
  assert.equal(await roleOf(stu.id), 'student', 'F-18: role in the database is unchanged');
  assert.equal((await api('/auth/me', { token: stu.token })).body.role, 'student');

  // the role route itself is admin-only
  const selfPromote = await api(`/users/${stu.id}/role`, { method: 'PUT', token: stu.token, body: { role: 'admin' } });
  assert.equal(selfPromote.status, 403);
});

test('F-18: profile writes validate name, avatar and password strength', async () => {
  const stu = await makeUser('student');

  assert.equal((await api(`/users/${stu.id}/profile`, { method: 'PUT', token: stu.token, body: { name: '   ' } })).status, 400, 'blank name refused');
  assert.equal((await api(`/users/${stu.id}/profile`, { method: 'PUT', token: stu.token, body: { name: 'x'.repeat(200) } })).status, 400, 'oversized name refused');

  const jsAvatar = await api(`/users/${stu.id}/profile`, { method: 'PUT', token: stu.token, body: { avatar: 'javascript:alert(1)' } });
  assert.equal(jsAvatar.status, 400, JSON.stringify(jsAvatar.body));
  assert.equal((await db().query('SELECT avatar FROM users WHERE id = $1', [stu.id])).rows[0].avatar, null, 'F-18: script URL never stored');

  // F-18: one password policy across register/change/reset (min 8, not the old >=6 shortcut)
  const weak = await api(`/users/${stu.id}/profile`, { method: 'PUT', token: stu.token, body: { password: 'Abc123', currentPassword: OLD_PW } });
  assert.equal(weak.status, 400, JSON.stringify(weak.body));
  assert.equal(weak.body?.error?.code, 'WEAK_PASSWORD');
});

test('F-18: an admin password reset kills the target\'s sessions but leaves the admin signed in', async () => {
  const admin = await makeUser('admin');
  const stu = await makeUser('student');

  const r = await api(`/users/${stu.id}/profile`, { method: 'PUT', token: admin.token, body: { password: NEW_PW } });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  assert.equal((await api('/auth/me', { token: stu.token })).status, 401, 'F-18: target user\'s live session is revoked');
  assert.equal((await api('/auth/me', { token: admin.token })).status, 200, 'the admin\'s own session is untouched');
  assert.equal((await api('/auth/login', { method: 'POST', body: { email: stu.email, password: NEW_PW } })).status, 200);
});

test('F-18: an admin role change revokes the target account\'s tokens', async () => {
  const admin = await makeUser('admin');
  const stu = await makeUser('student');

  const r = await api(`/users/${stu.id}/role`, { method: 'PUT', token: admin.token, body: { role: 'admin' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await api('/auth/me', { token: stu.token })).status, 401, 'F-18: token issued before the privilege change is dead');

  const again = await api('/auth/login', { method: 'POST', body: { email: stu.email, password: OLD_PW } });
  assert.equal(again.status, 200);
  assert.equal(again.body.user.role, 'admin', 'role comes from the database, not the old token');
});

test('F-18: an OTP password reset revokes existing sessions', async () => {
  const stu = await makeUser('student');
  const otp = '481516';
  await db().query(
    `INSERT INTO password_resets (user_id, otp_hash, expires_at)
     VALUES ($1, $2, now() + interval '5 minutes')`,
    [stu.id, await bcrypt.hash(otp, 10)]
  );

  const reset = await api('/auth/reset-password', { method: 'POST', body: { email: stu.email, otp, newPassword: NEW_PW } });
  assert.equal(reset.status, 200, JSON.stringify(reset.body));

  assert.equal((await api('/auth/me', { token: stu.token })).status, 401, 'F-18: reset signs the old session out');
  assert.equal((await db().query('SELECT count(*)::int AS n FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL', [stu.id])).rows[0].n, 0, 'all refresh families revoked');
  assert.equal((await api('/auth/login', { method: 'POST', body: { email: stu.email, password: NEW_PW } })).status, 200);
});
