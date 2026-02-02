# SaaS Starter -- Reusable Patterns

Documented patterns extracted from `lcb-projects/saas-starter`.
Each section lists the source files, what the pattern does, and how to reuse it.

---

## 1. Auth: Custom JWT with jose + bcryptjs

**Files:**
- `lib/auth/session.ts` -- JWT sign/verify, password hash/compare, cookie session
- `middleware.ts` -- Next.js edge middleware for route protection + session refresh

**What it does:**
- `hashPassword(password)` / `comparePasswords(plain, hashed)` -- bcryptjs wrappers
- `signToken(payload)` / `verifyToken(token)` -- HS256 JWT using `jose` (edge-compatible, no Node crypto)
- `getSession()` -- reads `session` cookie, verifies JWT, returns `{ user: { id }, expires }`
- `setSession(user)` -- creates JWT, sets httpOnly/secure/sameSite cookie (24h expiry)
- Middleware auto-refreshes session on every GET request (sliding window)
- Middleware redirects unauthenticated users from protected routes to `/sign-in`

**Env vars:** `AUTH_SECRET` (symmetric key for HS256)

**Dependencies:** `jose`, `bcryptjs`

**Portable version:** `_portable/auth/`

---

## 2. Validated Server Actions (Form Validation Wrappers)

**Files:**
- `lib/auth/middleware.ts` -- `validatedAction`, `validatedActionWithUser`, `withTeam`

**What it does:**
- `validatedAction(schema, handler)` -- wraps a Next.js server action with Zod validation.
  Parses `FormData` against the schema; returns `{ error }` on failure, calls handler on success.
- `validatedActionWithUser(schema, handler)` -- same as above but also fetches the authenticated user
  and passes it as the third argument. Throws if unauthenticated.
- `withTeam(handler)` -- wraps an action to fetch the current user's team. Redirects to `/sign-in`
  if not authenticated; throws if no team found.

**Usage pattern (from `app/(login)/actions.ts`):**
```ts
const signInSchema = z.object({
  email: z.string().email().min(3).max(255),
  password: z.string().min(8).max(100),
});

export const signIn = validatedAction(signInSchema, async (data, formData) => {
  // data is typed from the schema
  const { email, password } = data;
  // ...
});
```

**Dependencies:** `zod`

---

## 3. Teams / RBAC

**Files:**
- `lib/db/schema.ts` -- `teams`, `teamMembers`, `invitations` tables + relations
- `lib/db/queries.ts` -- `getTeamForUser()`, `getUserWithTeam()`
- `app/(login)/actions.ts` -- `inviteTeamMember`, `removeTeamMember`

**What it does:**
- Every user belongs to a team via `teamMembers` join table
- Roles: `owner` | `member` (stored as varchar on both `users.role` and `teamMembers.role`)
- New signups auto-create a team (`"{email}'s Team"`)
- Invitation system: pending invitations in `invitations` table, accepted on signup with `?inviteId=`
- `getTeamForUser()` returns full team with members (using Drizzle relational queries)
- `getUserWithTeam(userId)` returns user + teamId

**Schema highlights:**
```ts
teamMembers: { id, userId, teamId, role, joinedAt }
invitations: { id, teamId, email, role, invitedBy, invitedAt, status }
```

---

## 4. Stripe Billing

**Files:**
- `lib/payments/stripe.ts` -- Stripe client, checkout, portal, subscription handling
- `lib/payments/actions.ts` -- Server actions for checkout + portal
- `lib/db/schema.ts` -- `teams` table has Stripe fields

**What it does:**
- `createCheckoutSession({ team, priceId })` -- creates Stripe Checkout with 14-day trial
- `createCustomerPortalSession(team)` -- opens Stripe Customer Portal for subscription management
- `handleSubscriptionChange(subscription)` -- webhook handler for subscription status updates
- `getStripePrices()` / `getStripeProducts()` -- fetch active products/prices from Stripe

**Stripe fields on `teams` table:**
```ts
stripeCustomerId, stripeSubscriptionId, stripeProductId, planName, subscriptionStatus
```

**Env vars:** `STRIPE_SECRET_KEY`, `BASE_URL`

**Dependencies:** `stripe`

---

## 5. Activity Logging (Audit Trail)

**Files:**
- `lib/db/schema.ts` -- `activityLogs` table + `ActivityType` enum
- `lib/db/queries.ts` -- `getActivityLogs()`
- `app/(login)/actions.ts` -- `logActivity()` helper

**What it does:**
- Records user actions with team context, timestamp, and IP address
- Activity types: `SIGN_UP`, `SIGN_IN`, `SIGN_OUT`, `UPDATE_PASSWORD`, `DELETE_ACCOUNT`,
  `UPDATE_ACCOUNT`, `CREATE_TEAM`, `REMOVE_TEAM_MEMBER`, `INVITE_TEAM_MEMBER`, `ACCEPT_INVITATION`
- `getActivityLogs()` returns last 10 logs for the authenticated user

**Schema:**
```ts
activityLogs: { id, teamId, userId, action, timestamp, ipAddress }
```

---

## 6. Database (Drizzle + PostgreSQL)

**Files:**
- `lib/db/drizzle.ts` -- Connection setup (postgres.js + drizzle-orm)
- `lib/db/schema.ts` -- All tables, relations, and type exports
- `lib/db/seed.ts` -- Seed script (creates test user + Stripe products)
- `lib/db/queries.ts` -- Reusable query functions

**What it does:**
- Uses `postgres` (postgres.js) driver with `drizzle-orm`
- Full relational schema with `relations()` for type-safe nested queries
- Exports both select types (`User`) and insert types (`NewUser`) for every table
- Composite type `TeamDataWithMembers` for team + members + user info
- Soft delete pattern on users (`deletedAt` field, filtered with `isNull(users.deletedAt)`)

**Env vars:** `POSTGRES_URL`

**Dependencies:** `drizzle-orm`, `drizzle-kit`, `postgres`, `dotenv`

---

## 7. Login/Signup Server Actions

**Files:**
- `app/(login)/actions.ts`

**What it does:**
- `signIn` -- validates email/password, verifies against DB, sets session, logs activity, handles checkout redirect
- `signUp` -- creates user + team (or joins existing team via invitation), sets session
- `signOut` -- logs activity, deletes session cookie
- `updatePassword` -- validates current password, updates hash
- `deleteAccount` -- soft delete (appends `-{id}-deleted` to email for uniqueness)
- `updateAccount` -- updates name and email
- `inviteTeamMember` -- creates invitation record (TODO: email sending)
- `removeTeamMember` -- deletes team membership

---

## Pattern Dependencies Summary

| Pattern | jose | bcryptjs | zod | stripe | drizzle-orm | postgres |
|---------|------|----------|-----|--------|-------------|----------|
| Auth    | x    | x        |     |        |             |          |
| Validation |  |          | x   |        |             |          |
| Teams   |      |          |     |        | x           | x        |
| Billing |      |          |     | x      | x           | x        |
| Activity|      |          |     |        | x           | x        |
| Database|      |          |     |        | x           | x        |

## Env Vars Required

| Variable | Pattern | Description |
|----------|---------|-------------|
| `AUTH_SECRET` | Auth | HS256 symmetric key for JWT signing |
| `POSTGRES_URL` | Database | PostgreSQL connection string |
| `STRIPE_SECRET_KEY` | Billing | Stripe API secret key |
| `BASE_URL` | Billing | App URL for Stripe redirect callbacks |
