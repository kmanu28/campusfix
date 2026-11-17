import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { query } from './db';

export type RoleName = 'REPORTER' | 'STAFF' | 'ADMIN';

export interface UserSession {
  user_id: number;
  full_name: string;
  email: string;
  role_id: number;
  role_name: RoleName;
}

const SESSION_COOKIE_NAME = 'campusfix_session';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days

// ---------------------------------------------------------------------------
// Signed session cookie: base64url(payload).base64url(HMAC-SHA256)
// The payload cannot be modified by the browser without invalidating the signature.
// ---------------------------------------------------------------------------
function getSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (secret && secret.length >= 16) return secret;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET must be set (>= 16 chars) in production.');
  }
  return 'dev-only-insecure-session-secret-change-me';
}

function sign(data: string): string {
  return crypto.createHmac('sha256', getSecret()).update(data).digest('base64url');
}

function encodeSession(user: UserSession): string {
  const payload = Buffer.from(
    JSON.stringify({ ...user, exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS })
  ).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function decodeSession(token: string): UserSession | null {
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.exp || data.exp < Math.floor(Date.now() / 1000)) return null;
    const { exp: _exp, ...user } = data;
    return user as UserSession;
  } catch {
    return null;
  }
}

export async function getSession(): Promise<UserSession | null> {
  const cookieStore = await cookies();
  const cookie = cookieStore.get(SESSION_COOKIE_NAME);
  if (!cookie?.value) return null;
  return decodeSession(cookie.value);
}

export async function setSession(user: UserSession) {
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, encodeSession(user), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export async function clearSession() {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE_NAME);
}

/**
 * Guard for API routes. Returns the session, or a ready-made 401/403 response.
 * Usage:  const auth = await requireAuth(['ADMIN']);  if (auth instanceof NextResponse) return auth;
 */
export async function requireAuth(roles?: RoleName[]): Promise<UserSession | NextResponse> {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized: please sign in.' }, { status: 401 });
  }
  if (roles && !roles.includes(session.role_name)) {
    return NextResponse.json(
      { error: `Forbidden: requires role ${roles.join(' or ')}.` },
      { status: 403 }
    );
  }
  return session;
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------
export async function authenticateUser(email: string, password: string): Promise<UserSession | null> {
  if (!email || !password) return null;

  const res = await query(
    `SELECT u.user_id, u.full_name, u.email, u.password_hash, u.role_id, r.role_name
     FROM users u
     JOIN roles r ON u.role_id = r.role_id
     WHERE LOWER(u.email) = LOWER($1) AND u.is_active = TRUE`,
    [email.trim()]
  );

  // Compare against a dummy hash when the user is unknown so response time doesn't reveal
  // which emails exist.
  const row = res.rows[0];
  const hash = row?.password_hash || '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
  let ok = false;
  try {
    ok = await bcrypt.compare(password, hash);
  } catch {
    ok = false;
  }
  if (!row || !ok) return null;

  return {
    user_id: row.user_id,
    full_name: row.full_name,
    email: row.email,
    role_id: row.role_id,
    role_name: row.role_name,
  };
}

/** Public self-registration always creates a REPORTER (student/faculty) account. */
export async function registerReporter(
  fullName: string,
  email: string,
  password: string
): Promise<UserSession> {
  const cleanEmail = email.trim().toLowerCase();
  const passwordHash = await bcrypt.hash(password, 10);

  try {
    const res = await query(
      `INSERT INTO users (role_id, full_name, email, password_hash)
       SELECT r.role_id, $1, $2, $3 FROM roles r WHERE r.role_name = 'REPORTER'
       RETURNING user_id, full_name, email, role_id`,
      [fullName.trim(), cleanEmail, passwordHash]
    );
    const u = res.rows[0];
    return { user_id: u.user_id, full_name: u.full_name, email: u.email, role_id: u.role_id, role_name: 'REPORTER' };
  } catch (err: any) {
    if (err.code === '23505') throw new Error('A user with this email address already exists.');
    if (err.code === '23514') throw new Error('Please enter a valid email address.');
    throw err;
  }
}

export function isDemoMode(): boolean {
  return (process.env.DEMO_MODE || '').toLowerCase() === 'true';
}

export async function getAllUsers(): Promise<UserSession[]> {
  const res = await query(
    `SELECT u.user_id, u.full_name, u.email, u.role_id, r.role_name
     FROM users u
     JOIN roles r ON u.role_id = r.role_id
     WHERE u.is_active = TRUE
     ORDER BY u.role_id ASC, u.user_id ASC`
  );
  return res.rows;
}
