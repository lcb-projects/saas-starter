/**
 * Portable Auth Session Module
 *
 * JWT-based session management using jose (edge-compatible).
 * Password hashing with bcryptjs.
 *
 * Source: saas-starter/lib/auth/session.ts
 *
 * Required env: AUTH_SECRET
 * Required deps: jose, bcryptjs
 */

import { compare, hash } from 'bcryptjs';
import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';

const key = new TextEncoder().encode(process.env.AUTH_SECRET);
const SALT_ROUNDS = 10;

// ---------------------------------------------------------------------------
// Password utilities
// ---------------------------------------------------------------------------

export async function hashPassword(password: string): Promise<string> {
  return hash(password, SALT_ROUNDS);
}

export async function comparePasswords(
  plainTextPassword: string,
  hashedPassword: string
): Promise<boolean> {
  return compare(plainTextPassword, hashedPassword);
}

// ---------------------------------------------------------------------------
// JWT token utilities
// ---------------------------------------------------------------------------

export type SessionData = {
  user: { id: number };
  expires: string;
};

export async function signToken(payload: SessionData): Promise<string> {
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1 day from now')
    .sign(key);
}

export async function verifyToken(input: string): Promise<SessionData> {
  const { payload } = await jwtVerify(input, key, {
    algorithms: ['HS256'],
  });
  return payload as SessionData;
}

// ---------------------------------------------------------------------------
// Cookie-based session management
// ---------------------------------------------------------------------------

const SESSION_COOKIE = 'session';
const SESSION_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

export async function getSession(): Promise<SessionData | null> {
  const session = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!session) return null;
  return await verifyToken(session);
}

export async function setSession(user: { id: number }): Promise<void> {
  const expiresInOneDay = new Date(Date.now() + SESSION_DURATION_MS);
  const session: SessionData = {
    user: { id: user.id },
    expires: expiresInOneDay.toISOString(),
  };
  const encryptedSession = await signToken(session);
  (await cookies()).set(SESSION_COOKIE, encryptedSession, {
    expires: expiresInOneDay,
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
  });
}
