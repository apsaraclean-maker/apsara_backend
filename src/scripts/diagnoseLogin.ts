import 'dotenv/config';
import mongoose from 'mongoose';
import { User, ActiveSession, Business } from '../models.js';

/**
 * End-to-end login diagnostic. Answers "why can't I log in?" without guesswork by walking the
 * same path the browser does and reporting where it stops.
 *
 *   npm run diagnose-login                    (defaults to the dummy owner)
 *   npm run diagnose-login -- 9000000001 Dummy@123
 *
 * Checks, in the order they can fail:
 *   1. Is the API process actually listening on the configured port
 *   2. Does the CORS preflight succeed for the frontend origin
 *   3. Does POST /auth/login succeed, and does it hand back a session cookie
 *   4. Does that cookie survive a round trip to GET /auth/me
 *   5. Account-level blockers: disabled, locked out, paused business, device limit
 */

const PORT = process.env.PORT || 8000;
const BASE = `http://localhost:${PORT}`;
const ORIGIN = 'http://localhost:3000';

const phone = process.argv[2] || '9000000001';
const password = process.argv[3] || 'Dummy@123';

const ok = (s: string) => console.log(`  ✓ ${s}`);
const bad = (s: string) => console.log(`  ✗ ${s}`);

async function main() {
  console.log(`\nDiagnosing login for ${phone} against ${BASE}\n`);

  // ── 1. process reachable ──────────────────────────────────────────────────
  console.log('1. API reachable');
  try {
    const r = await fetch(`${BASE}/check-status`, { signal: AbortSignal.timeout(5000) });
    ok(`GET /check-status -> ${r.status}`);
  } catch {
    bad(`nothing listening on ${BASE}`);
    console.log('\n   THIS IS THE PROBLEM. Start the backend:');
    console.log('     npm run dev      (watch mode, runs src/)');
    console.log('     npm start        (runs the built dist/)\n');
    return;
  }

  // ── 2. CORS preflight ─────────────────────────────────────────────────────
  console.log('\n2. CORS preflight from the frontend origin');
  const pre = await fetch(`${BASE}/api/auth/login`, {
    method: 'OPTIONS',
    headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
  });
  const allowOrigin = pre.headers.get('access-control-allow-origin');
  const allowCreds = pre.headers.get('access-control-allow-credentials');
  if (allowOrigin === ORIGIN && allowCreds === 'true') ok(`${pre.status}, allow-origin=${allowOrigin}, allow-credentials=${allowCreds}`);
  else bad(`${pre.status}, allow-origin=${allowOrigin}, allow-credentials=${allowCreds} — ${ORIGIN} must be in ALLOWED_ORIGINS (server.ts)`);

  // ── 3. login ──────────────────────────────────────────────────────────────
  console.log('\n3. POST /api/auth/login');
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ phone, password }),
  });
  const body = await login.text();
  if (login.ok) ok(`${login.status} ${body.slice(0, 80)}…`);
  else bad(`${login.status} ${body.slice(0, 220)}`);

  const setCookie = login.headers.get('set-cookie');
  if (setCookie) ok(`Set-Cookie issued: ${setCookie.split(';')[0].slice(0, 40)}… [${setCookie.split(';').slice(1).map((s) => s.trim()).join(', ')}]`);
  else bad('no Set-Cookie on the login response');

  // ── 4. cookie round trip ──────────────────────────────────────────────────
  if (setCookie) {
    console.log('\n4. GET /api/auth/me carrying that cookie');
    const me = await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: setCookie.split(';')[0], Origin: ORIGIN } });
    if (me.ok) ok(`${me.status} — the server-side flow is healthy end to end`);
    else bad(`${me.status} — session did not survive the round trip`);
  }

  // ── 5. account-level blockers ─────────────────────────────────────────────
  console.log('\n5. Account state');
  await mongoose.connect(process.env.MONGODB_URI!, { family: 4 });
  const u = await User.findOne({ phone, deleted_at: null }).lean();
  if (!u) {
    bad(`no user with phone ${phone}`);
  } else {
    u.is_active === true ? ok('account is active') : bad('account is disabled (is_active is not true)');
    u.locked_until && new Date(u.locked_until) > new Date() ? bad(`locked until ${new Date(u.locked_until).toISOString()}`) : ok('not locked out');
    (u.failed_login_count ?? 0) === 0 ? ok('failed_login_count is 0') : console.log(`  ! failed_login_count = ${u.failed_login_count} (30 disables the account)`);
    if (u.business_id) {
      const b = await Business.findById(u.business_id).select('name status').lean();
      b?.status === 'active' ? ok(`business "${b.name}" is active`) : bad(`business is ${b?.status}`);
    }
    const n = await ActiveSession.countDocuments({ user_id: u._id });
    n < 3 ? ok(`${n}/3 device slots used`) : bad(`${n}/3 device slots used — at the limit`);
    if (u.role !== 'owner' && u.role !== 'admin') {
      console.log(`  ! role is "${u.role}" — staff sign in with their PIN, not a password`);
    }
  }

  console.log('\nIf every check above passed but the browser still fails, the problem is in the');
  console.log('browser rather than the API — most often a stale connect.sid cookie (clear it in');
  console.log('DevTools > Application > Cookies) or an embedded webview blocking third-party');
  console.log('cookies. Try a normal Chrome/Edge window at http://localhost:3000.\n');

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
