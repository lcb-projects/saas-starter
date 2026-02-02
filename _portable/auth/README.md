# Portable Auth Module

Drop-in JWT authentication for Next.js + Drizzle projects.
Extracted from [lcb-projects/saas-starter](https://github.com/lcb-projects/saas-starter).

## Files

| File | Purpose |
|------|---------|
| `session.ts` | JWT sign/verify (jose), password hash/compare (bcryptjs), cookie session get/set |
| `helpers.ts` | `validatedAction` (Zod form validation), `createValidatedActionWithUser` (+ auth) |
| `middleware.ts` | Next.js middleware for route protection + sliding session refresh |
| `schema.ts` | Drizzle `users` table with type exports (`User`, `NewUser`) |

## Setup

### 1. Install dependencies

```bash
bun add jose bcryptjs zod drizzle-orm
bun add -d @types/bcryptjs
```

### 2. Copy files into your project

```
your-project/
  lib/auth/
    session.ts      <-- from _portable/auth/session.ts
    helpers.ts      <-- from _portable/auth/helpers.ts
  middleware.ts     <-- from _portable/auth/middleware.ts (adjust imports)
  lib/db/
    schema.ts       <-- merge _portable/auth/schema.ts into your schema
```

### 3. Set environment variable

```env
AUTH_SECRET=your-secret-key-at-least-32-chars
```

Generate a secure secret:
```bash
openssl rand -base64 32
```

### 4. Configure middleware imports

After copying `middleware.ts` to your project root, update the import path:

```ts
// Change this:
import { signToken, verifyToken } from './session';

// To match your project structure:
import { signToken, verifyToken } from '@/lib/auth/session';
```

### 5. Configure route protection

In `middleware.ts`, adjust the protected routes:

```ts
const protectedRoutes = '/dashboard';  // Change to your protected path prefix
const signInPath = '/sign-in';         // Change to your login page
```

### 6. Wire up validatedActionWithUser

The `helpers.ts` module needs a `getUser()` function. Create one or use the pattern from `saas-starter`:

```ts
// lib/db/queries.ts
import { cookies } from 'next/headers';
import { verifyToken } from '@/lib/auth/session';
import { db } from './drizzle';
import { users } from './schema';
import { eq, isNull, and } from 'drizzle-orm';

export async function getUser() {
  const sessionCookie = (await cookies()).get('session');
  if (!sessionCookie?.value) return null;

  const sessionData = await verifyToken(sessionCookie.value);
  if (!sessionData?.user?.id || typeof sessionData.user.id !== 'number') return null;
  if (new Date(sessionData.expires) < new Date()) return null;

  const [user] = await db
    .select()
    .from(users)
    .where(and(eq(users.id, sessionData.user.id), isNull(users.deletedAt)))
    .limit(1);

  return user ?? null;
}
```

Then wire it up:

```ts
// lib/auth/middleware.ts (or wherever you keep action helpers)
import { createValidatedActionWithUser } from '@/lib/auth/helpers';
import { getUser } from '@/lib/db/queries';

export const validatedActionWithUser = createValidatedActionWithUser(getUser);
export { validatedAction } from '@/lib/auth/helpers';
```

## How it works

### Session flow
1. User signs in -> `setSession(user)` creates a JWT and sets an httpOnly cookie
2. On each GET request, middleware verifies the JWT and refreshes it (sliding 24h window)
3. Protected routes redirect to sign-in if no valid session cookie exists
4. `getSession()` can be called from any server component or action to get the current user ID

### Password flow
1. On signup: `hashPassword(password)` -> store `passwordHash` in DB
2. On login: `comparePasswords(plaintext, hash)` -> verify match

### Action validation flow
1. Wrap server action with `validatedAction(zodSchema, handler)`
2. FormData is automatically parsed and validated against the schema
3. Handler receives typed, validated data
4. For authenticated actions, use `validatedActionWithUser` to also inject the user

## Architecture decisions

- **jose over jsonwebtoken**: jose works in Edge Runtime (middleware). jsonwebtoken requires Node.js crypto.
- **bcryptjs over bcrypt**: Pure JS, no native bindings. Works everywhere.
- **Cookie-based sessions**: No external session store needed. JWT contains the user ID.
- **Sliding window refresh**: Session extends on every page visit. Users stay logged in while active.
- **httpOnly + secure + sameSite=lax**: XSS-resistant, CSRF-resistant cookie configuration.
