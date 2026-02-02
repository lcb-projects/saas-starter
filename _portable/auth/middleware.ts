/**
 * Portable Next.js Auth Middleware
 *
 * Drop-in middleware.ts for any Next.js project using JWT sessions.
 * Handles:
 * - Route protection (redirect unauthenticated users)
 * - Sliding session refresh on GET requests
 * - Graceful session expiry (delete cookie on verify failure)
 *
 * Source: saas-starter/middleware.ts
 *
 * USAGE: Copy this file to your project root as middleware.ts.
 *        Adjust `protectedRoutes` and `signInPath` as needed.
 *        Import signToken/verifyToken from your session module.
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { signToken, verifyToken } from './session';

// ---------------------------------------------------------------------------
// Configuration -- adjust these for your project
// ---------------------------------------------------------------------------

/** Routes that require authentication (prefix match) */
const protectedRoutes = '/dashboard';

/** Where to redirect unauthenticated users */
const signInPath = '/sign-in';

/** Cookie name (must match session.ts) */
const SESSION_COOKIE = 'session';

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const sessionCookie = request.cookies.get(SESSION_COOKIE);
  const isProtectedRoute = pathname.startsWith(protectedRoutes);

  // Redirect unauthenticated users away from protected routes
  if (isProtectedRoute && !sessionCookie) {
    return NextResponse.redirect(new URL(signInPath, request.url));
  }

  let res = NextResponse.next();

  // Refresh session on GET requests (sliding window)
  if (sessionCookie && request.method === 'GET') {
    try {
      const parsed = await verifyToken(sessionCookie.value);
      const expiresInOneDay = new Date(Date.now() + 24 * 60 * 60 * 1000);

      res.cookies.set({
        name: SESSION_COOKIE,
        value: await signToken({
          ...parsed,
          expires: expiresInOneDay.toISOString(),
        }),
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        expires: expiresInOneDay,
      });
    } catch (error) {
      console.error('Error updating session:', error);
      res.cookies.delete(SESSION_COOKIE);
      if (isProtectedRoute) {
        return NextResponse.redirect(new URL(signInPath, request.url));
      }
    }
  }

  return res;
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
  runtime: 'nodejs',
};
