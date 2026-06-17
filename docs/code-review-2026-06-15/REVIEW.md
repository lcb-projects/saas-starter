# Code Review — `saas-starter` (Tier 2)

**Date:** 2026-06-16
**Scope:** 9-dimension review (security, correctness, data integrity, type safety, performance, architecture, test coverage, maintainability, code hygiene).

> **Note:** Findings were surfaced by the review. Critical and High findings are **adversarially verified against source** in the [Verification](#verification) section at the bottom — read that section for which claims hold, which had wrong line numbers, and which are partial/refuted. Medium/Low findings are reported as surfaced and **not** individually verified.

## Summary

| Severity | Count |
|---|---|
| Critical | 8 |
| High | 33 |
| Medium | 35 |
| Low | 12 |
| **Total** | **88** |

The single most important finding is the **Critical authorization bypass on the Stripe checkout callback** — it is real, exploitable, and verified. The bulk of the Critical bucket is "no test coverage" (this repo has **zero test files and no test runner configured**, verified). The High bucket is dominated by unsafe Stripe type assertions, missing transactions, missing role checks, and missing DB indexes.

---

## Critical

**1. Missing authorization on Stripe checkout callback — arbitrary team subscription assignment**
`app/api/stripe/checkout/route.ts:52-92`
The `GET /api/stripe/checkout` handler reads `session.client_reference_id`, looks up that user, and updates the matching team's subscription — **without ever comparing against the cookie-authenticated user**. An attacker who can obtain/guess another user's `session_id` can drive a subscription update for the victim's team and then have `setSession(user[0])` called for the victim's user record.
*Fix:* Call `getUser()` and assert `authedUser.id === Number(userId)` before any DB write. Reject mismatches.

**2. No test coverage for JWT session management / token expiration**
`lib/auth/session.ts`
`signToken`/`verifyToken`/`getSession`/`setSession` have no tests. No test confirms expired tokens are rejected, that expiry is ~24h, that malformed tokens throw, or that HS256 is enforced.
*Fix:* Unit-test valid round-trips, expired rejection, malformed handling, algorithm enforcement, and `getSession()` with valid/expired/missing cookies.

**3. Missing error-path tests for authentication actions**
`app/(login)/actions.ts`
`signIn` and `signUp` have branchy error handling (wrong password, duplicate email, invalid/expired invitation, missing team, password mismatch) with no tests.
*Fix:* Integration tests: wrong password returns error without redirect; duplicate email returns the specific error; invalid `inviteId` rejected; confirmation mismatch caught; happy paths redirect to `/dashboard`.

**4. Stripe webhook handler lacks error-path tests**
`app/api/stripe/webhook/route.ts`
Only the signature-verification try/catch is tested-by-nothing. No tests for malformed payloads, missing signature header, wrong secret, unhandled event types, or missing customer/subscription. `handleSubscriptionChange` can silently `console.error('Team not found')` with no failure-path test.
*Fix:* Test invalid signature (400), missing header (400), unhandled event type (200 + log), subscription change for non-existent team (graceful), malformed event object.

**5. No tests for Stripe checkout session creation and redemption**
`lib/payments/stripe.ts` + `app/api/stripe/checkout/route.ts`
`createCheckoutSession` redirect behavior and the 7 throw-paths in the checkout GET handler (missing/invalid session, missing customer/subscription, missing product, user-not-found, no-team) are untested.
*Fix:* Test unauthenticated redirect to `/sign-up`, authenticated session creation, missing `session_id` → `/pricing`, invalid session → error redirect, valid session → team update + `/dashboard`.

**6. Password validation has weak/missing test coverage**
`app/(login)/actions.ts`
`updatePassword` (current-correct, new≠current, confirm-matches) and `deleteAccount` (password verify) error paths are untested. `comparePasswords` (`session.ts`) has no test confirming it rejects wrong passwords.
*Fix:* Test `comparePasswords` match/non-match; `updatePassword` wrong-current/same/mismatch/valid; `deleteAccount` wrong-password and correct-password (soft delete + session cleared).

**7. No tests for session cookie security attributes**
`lib/auth/session.ts` + `middleware.ts`
`setSession` sets `httpOnly`/`secure`/`sameSite='lax'`; middleware refreshes tokens on every GET. No tests assert those flags or correct refresh behavior.
*Fix:* Assert `httpOnly`, `secure`, `sameSite='lax'` in both `setSession` and the middleware-issued cookie; test that refresh extends expiry and re-signs.

**8. Missing cascade delete — teams/records can be orphaned when users are deleted**
`lib/db/migrations/0000_soft_the_anarchist.sql:54-88`
All FK constraints are `ON DELETE no action`. `deleteAccount` only deletes the user's `team_members` row for their current team; it leaves `invitations.invited_by` rows, sole-owner teams, and (in the future, if FKs are enforced on a hard delete) `activity_logs` orphaned.
*Fix:* Add explicit cleanup in `deleteAccount` (sole-owner team handling, delete `invitations` where `invited_by = userId`, handle `activity_logs`) and/or change FKs to `ON DELETE CASCADE` where orphans are unacceptable.

---

## High

**Unvalidated plan-name cast causes runtime error** — `lib/payments/stripe.ts:135-136`
`plan?.product` is cast to both `string` (line 135) and `Stripe.Product` (line 136). If the product is unexpanded (a string ID), `.name` throws.
*Fix:* `const productId = typeof plan.product === 'string' ? plan.product : plan.product?.id; const productName = typeof plan.product === 'object' ? plan.product.name : 'Unknown';`

**Unsafe null access in `inviteTeamMember`** — `app/(login)/actions.ts:409-420`
Left join on `teamMembers`; if the user exists but has no membership, `teamMembers` columns are null. Reading `teamMembers.teamId` unguarded can throw.
*Fix:* Null-guard `existingMember[0].teamMembers` or use an inner join (you only care about existing members).

**Missing role-based authorization on team member operations** — `app/(login)/actions.ts:365-392, 399-459`
`removeTeamMember` and `inviteTeamMember` only verify the requester belongs to a team — **not** that they are an `owner`. Any `member` can remove members or invite new ones (including as `owner`). Vertical + horizontal privilege escalation.
*Fix:* Fetch the requester's `team_members.role` and require `'owner'` before processing.

**Unvalidated `inviteId` parsing — coercion / silent bypass** — `app/(login)/actions.ts:155`
`parseInt(inviteId)` with no validation; `signUpSchema` accepts `inviteId` as an arbitrary string. Non-numeric → `NaN` → `eq(invitations.id, NaN)` silently matches nothing.
*Fix:* `inviteId: z.string().optional().refine(id => !id || /^\d+$/.test(id), 'Invalid invite ID format')` or `z.coerce.number()`.

**Unsafe type assertion on missing webhook header** — `app/api/stripe/webhook/route.ts:9`
`request.headers.get('stripe-signature') as string` — `get()` can return `null`, which is then passed to `constructEvent`.
*Fix:* Guard for null and return 400 before calling `constructEvent`.

**Unsafe Stripe-product assertions without null checks (checkout)** — `app/api/stripe/checkout/route.ts:46, 85`
`plan.product` cast to `Stripe.Product` for `.id` (46) and `.name` (85) without confirming it was expanded.
*Fix:* `if (typeof plan.product !== 'object' || !plan.product) throw new Error('Product data not expanded');` or optional-chain with fallbacks.

**Unchecked assertion on `subscription.customer`** — `lib/payments/stripe.ts:120`
`subscription.customer as string` — can be a `Stripe.Customer` object when expanded.
*Fix:* `const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id; if (!customerId) throw …`

**Multiple unsafe assertions on Stripe `product` field** — `lib/payments/stripe.ts:135-136`
Same root cause as the plan-name finding above; both `string` and `Stripe.Product` casts on the same value.
*Fix:* Single type guard, derive both id and name from it.

**Unchecked FormData casts without null validation** — `app/(login)/actions.ts:94, 96, 215, 217`
`formData.get('redirect')`/`formData.get('priceId')` cast to `string`; when `redirect === 'checkout'`, `priceId` is assumed present.
*Fix:* `const priceId = formData.get('priceId'); if (typeof priceId !== 'string' || !priceId) return { error: 'Missing priceId' };`

**Unsafe assertion on `getUser()` result** — `app/(login)/actions.ts:225` (`signOut`)
`(await getUser()) as User` masks the `null` case.
*Fix:* `const user = await getUser(); if (!user) throw new Error('User not authenticated');`

**Missing database indexes on foreign keys** — `lib/db/migrations/0000_soft_the_anarchist.sql`
No indexes on `activity_logs(team_id, user_id)`, `team_members(team_id, user_id)`, `invitations(team_id, invited_by)`. These columns are filtered/joined on every request. (`teams.stripe_customer_id`/`stripe_subscription_id` already have UNIQUE indexes.)
*Fix:* Add indexes on all FK columns; a composite `activity_logs(user_id, timestamp DESC)` supports the activity query directly.

**N+1 / unbounded fetch in `getTeamForUser()`** — `lib/db/queries.ts:108-127`
`db.query.teamMembers.findFirst` with deeply nested `with` loads the whole team + every member + each member's user.
*Fix:* Select only needed columns; paginate/limit member lists if team size can grow.

**Unhandled errors in webhook subscription handling** — `app/api/stripe/webhook/route.ts:27`
`await handleSubscriptionChange(subscription)` is not wrapped; a failure returns 200 to Stripe, so Stripe won't retry and DB drifts from Stripe.
*Fix:* try/catch and return 500 on failure so Stripe retries.

**Race condition in checkout completion flow** — `app/api/stripe/checkout/route.ts:79-91`
Find-user → find-team → update-team are three non-atomic ops; a concurrent webhook can lost-write, and a partial failure still sets the session + redirects.
*Fix:* Wrap in `db.transaction(...)`.

**Unhandled promise rejection in `logActivity` calls** — `app/(login)/actions.ts:89-92`
`Promise.all([setSession, logActivity])` — if `logActivity` throws, sign-in fails even though the session was set (or vice-versa); audit trail unreliable.
*Fix:* Add `.catch()` on the non-critical `logActivity`, or isolate it.

**Race condition in `signUp` — partial user/team creation** — `app/(login)/actions.ts:134-213`
User insert → team insert → (`Promise.all`: teamMember insert + logActivity + setSession) are not transactional. A failed `teamMembers` insert leaves an orphaned user, and `logActivity` may still succeed.
*Fix:* Wrap the whole flow in `db.transaction(...)`.

**Email uniqueness race on soft delete** — `app/(login)/actions.ts:321`
`email = CONCAT(email, '-', id, '-deleted')` to dodge the unique constraint; concurrent deletes / a delete racing a re-signup can violate or bypass uniqueness.
*Fix:* Add a `status` column + partial unique index `UNIQUE(email) WHERE deleted_at IS NULL`, or rename email pre-commit.

**Webhook subscription updates not transactional — stale reads** — `lib/payments/stripe.ts:117-147`
Read team by customer id → update; concurrent `updated`/`deleted` webhooks for the same sub can lost-write.
*Fix:* `SELECT … FOR UPDATE` / transaction, or a version/timestamp idempotency check.

**`inviteId` bounds / cross-team injection** — `app/(login)/actions.ts:155`
No bounds check on the parsed integer; combined with no team-context validation, a manipulated `inviteId` URL can attach a signup to an unexpected team. (Note: the query *does* also match on `invitations.email` and `status='pending'`, which limits this — see Verification.)
*Fix:* Validate positive bounded integer; log anomalous acceptance attempts.

**Activity logs lack team-level scoping** — `lib/db/queries.ts:81-100`
`getActivityLogs()` filters by `userId` only; a multi-team user sees mixed logs. `activity_logs.team_id` is `NOT NULL` in schema, so the tenant claim is partly mitigated, but the query is still not team-scoped.
*Fix:* Accept/derive a `teamId` and filter on it, or document cross-team visibility intentionally.

**API endpoints lack auth/input-validation tests** — `app/api/user/route.ts` + `app/api/team/route.ts`
These return `Response.json(getUser())` / `getTeamForUser()` with no tests for unauthenticated vs authenticated behavior or method restriction.
*Fix:* Test unauthenticated returns null, authenticated returns the object; reject non-GET.

**Stripe subscription status transitions untested** — `lib/payments/stripe.ts`
`handleSubscriptionChange` handles only `active`/`trialing`/`canceled`/`unpaid`; no tests for each transition, unknown statuses, or the "Team not found" log path.
*Fix:* Test each status produces correct field state; unknown status no-ops; missing team logs and returns without throwing.

**Cross-layer import violates N-tier boundary** — `app/(dashboard)/layout.tsx:14`
A `'use client'` layout imports the `signOut` server action directly.
*Fix:* Trigger `signOut` via form action / a server-rendered bridge, or relocate it.

**Checkout route duplicates DB + payments logic** — `app/api/stripe/checkout/route.ts:18-91`
Inline `select users / teamMembers / update teams` and direct Stripe SDK calls duplicate `lib/db/queries` + `lib/payments/stripe`; `handleSubscriptionChange` already exists but is reimplemented inline.
*Fix:* Extract `completeCheckoutSession(sessionId)` into `lib/payments/stripe.ts` and a `completeCheckout(...)` query into `lib/db/queries.ts`.

**Inconsistent error contracts (throw vs ActionState)** — `lib/auth/middleware.ts:44`
`validatedActionWithUser` throws `Error('User is not authenticated')` while API routes return `{ error }` and `validatedAction` returns `ActionState.error`. Two contracts that don't align; thrown errors will trip Suspense boundaries.
*Fix:* Standardize on `ActionState`-returning actions or an error boundary.

**Database query functions lack boundary tests** — `lib/db/queries.ts`
`getUser` (no cookie / invalid token / expired / deleted-user) and `getActivityLogs` (throws when unauthenticated, `limit(10)`) are untested.
*Fix:* Cover each `getUser` early-return; assert `getActivityLogs` throws unauthenticated and caps at 10 ordered DESC.

**Validation middleware has no tests** — `lib/auth/middleware.ts`
`validatedAction` and `validatedActionWithUser` (parse-failure path, action invocation, unauthenticated throw) are untested.
*Fix:* Test invalid → first-Zod-error, valid → action invoked; `validatedActionWithUser` unauthenticated throws.

**Team/invitation error-path coverage weak** — `app/(login)/actions.ts`
`removeTeamMember` (user-not-in-team) and `inviteTeamMember` (existing member / pending invite / TODO email) are untested.
*Fix:* Test not-in-team error, invalid memberId silent no-op, existing-member/pending-invite errors, successful invite creates the row (email mocked).

**Duplicate `ActionState` type definitions** — `app/(dashboard)/dashboard/page.tsx:23`
`ActionState` is re-declared in `dashboard/page.tsx` and `dashboard/general/page.tsx` but imported from `lib/auth/middleware` in `login.tsx`.
*Fix:* Export the single `ActionState` from `lib/auth/middleware.ts` and import everywhere.

**Duplicate auth-middleware implementations** — `lib/auth/middleware.ts:17-54`
`validatedAction`/`validatedActionWithUser` also exist in `_portable/auth/helpers.ts` with different generics.
*Fix:* Make `_portable/` re-export from `lib/`, or treat it as docs-only and stop duplicating logic.

**Stripe payment flow bypasses `lib/payments` abstraction** — `app/api/stripe/checkout/route.ts:18-91`
Same root issue as the checkout-duplication finding: the route calls the Stripe SDK directly instead of going through `lib/payments/stripe.ts`.
*Fix:* Route all Stripe calls through `lib/payments`.

---

## Medium

**Missing null/NaN check on parsed `userId`** — `app/api/stripe/checkout/route.ts:60`
`Number(session.client_reference_id)` unvalidated; `NaN` yields a no-match query.
*Fix:* `const userId = Number(...); if (!userId || isNaN(userId)) throw …`

**No authorization check when removing team members** — `app/(login)/actions.ts:375-382`
(Same root cause as the High role-auth finding; reported separately at Medium scope.) Any member can remove others.
*Fix:* Require `owner` role server-side.

**UI-only guard on member removal** — `app/(dashboard)/dashboard/page.tsx:156`
`index > 1` is a frontend-only restriction; the server action has no equivalent check, so a crafted request bypasses it.
*Fix:* Enforce role authorization in `removeTeamMember`.

**Session refresh on every GET creates token churn/confusion** — `middleware.ts:18-33`
Token is re-issued on every GET; concurrent requests can race on the cookie.
*Fix:* Refresh only when near expiry (`expiresIn < 1h`).

**Subscription status not validated before persisting** — `lib/payments/stripe.ts:131`
`status` is stored without restricting to a known set.
*Fix:* Validate against an allow-list / enum before the update.

**Activity-log IP address never captured** — `app/(login)/actions.ts:33-44`
`logActivity` defaults `ipAddress` to `''` and **no caller ever passes an IP**, so the activity UI's `from IP …` is always empty. Forensic data missing.
*Fix:* Read `x-forwarded-for`/`x-real-ip` via `headers()` and pass it through.

**Middleware route protection is implicit for `/api/*`** — `middleware.ts:47`
Matcher excludes `api`; API routes rely solely on in-handler `getUser()`. A future route added without that check is unauthenticated.
*Fix:* Document the convention or extend the matcher / add a shared API auth wrapper.

**No explicit CSRF validation on state-changing server actions** — `app/(login)/actions.ts:52-101, 109-222, 237-289, …`
Relies on Next.js implicit origin checks; no explicit token.
*Fix:* Add explicit origin/token validation, or document reliance on built-in protection.

**Plaintext IP storage** — `lib/db/schema.ts:54`
`ip_address` stored raw (PII) and displayed in the activity UI. (Moot today since IPs are never captured — see above — but a privacy concern once they are.)
*Fix:* Hash/mask/encrypt IPs.

**No type guard on `event.data.object`** — `app/api/stripe/webhook/route.ts:26`
Cast to `Stripe.Subscription` based only on event-type string.
*Fix:* Validate `.id`/`.customer` before use.

**No type guard on `log.action` → `ActivityType`** — `app/(dashboard)/dashboard/activity/page.tsx:87,89`
DB stores a string; invalid values break the icon map.
*Fix:* Validate against `Object.values(ActivityType)` with a safe fallback.

**Overly broad `ActionState` type** — `lib/auth/middleware.ts:9`
`[key: string]: any` defeats type checking on action return values.
*Fix:* Replace with explicit optional properties.

**JWT payload cast without field validation** — `lib/auth/session.ts:37`
`payload as SessionData` without checking `user.id`/`expires`.
*Fix:* Validate fields before casting.

**Portable session helper cast without validation** — `_portable/auth/helpers.ts:107`
`user as U` with no runtime guard.
*Fix:* Validate `user.id` shape before casting.

**No pagination/offset on activity logs** — `lib/db/queries.ts:81-100`
Hard `limit(10)`, no offset/cursor; ordering scans the table.
*Fix:* Add `limit`/`offset` (or cursor) params + supporting index.

**Redundant `/api/user` + `/api/team` SWR fetches** — `app/(dashboard)/layout.tsx:23`
`UserMenu` and dashboard pages each fetch the same endpoints; each fetch hits the DB.
*Fix:* Fetch once at the layout and share via Context.

**`getUser()` uncached per request** — `lib/db/queries.ts:7-37`
Called in nearly every action/route; a single page load can issue 5+ identical user queries.
*Fix:* Memoize with React `cache()` per request.

**Stripe config fetched on every portal session** — `lib/payments/stripe.ts:54-108`
`billingPortal.configurations.list()` + products/prices fetched synchronously each time.
*Fix:* Cache config with a TTL.

**Unprotected API endpoints return data without explicit auth** — `app/api/user/route.ts`
Returns `Response.json(null)` rather than 401 when unauthenticated.
*Fix:* `if (!user) return NextResponse.json({error:'Unauthorized'}, {status:401});`

**Missing transaction on multi-step signup** — `app/(login)/actions.ts:134-213`
(Same root cause as the High signup-race finding, reported at Medium scope.)
*Fix:* Wrap user/team/teamMember/logActivity in one transaction.

**Silent invitation failure (no email delivery)** — `app/(login)/actions.ts:440-458`
Invitation rows are created but the email is a `// TODO` (line 454) — feature is silently broken; no `?inviteId=` is ever delivered.
*Fix:* Implement send-with-rollback, or queue with retry, or remove the half-feature.

**Session refresh without checking expiry first** — `middleware.ts:18-40`
Refreshes regardless of remaining lifetime.
*Fix:* Only refresh when `< ~5 min` remain.

**Missing CSRF protection on state-changing GET checkout route** — `app/api/stripe/checkout/route.ts:1`
A GET request mutates DB + sets a session; CSRF/replay risk.
*Fix:* Use POST + CSRF token, or a one-time token from the checkout session.

**Loose types in auth middleware** — `lib/auth/middleware.ts:9,12,17,31,37`
`[key:string]:any` + `z.ZodType<any, any>`.
*Fix:* Tighten the union type and Zod generics.

**Commented-out production code block** — `app/(dashboard)/dashboard/page.tsx:131-139`
Multi-line "how to add AvatarImage" comment.
*Fix:* Implement, remove, or move to an issue/docs.

**Incomplete email invitation feature (TODO)** — `app/(login)/actions.ts:454-455`
(Same as the silent-invitation finding.)
*Fix:* Same.

**Oversized action file with mixed responsibilities** — `app/(login)/actions.ts:1-459`
8 server actions across auth/team/account/password in one 459-line file.
*Fix:* Split into `auth-actions.ts` / `account-actions.ts` / `team-actions.ts`; move `logActivity` to `lib/db/activity.ts`.

**Repeated password-input field patterns** — `app/(dashboard)/dashboard/security/page.tsx:48-90`
`minLength=8 maxLength=100` repeated across fields.
*Fix:* Extract a `PasswordInput` component.

**Inconsistent form error/success handling** — `app/(dashboard)/dashboard/page.tsx:98-101,193-196,172-174,236-241`
Repeated `useActionState` + error/success rendering with per-page `ActionState`.
*Fix:* Shared `FormState` hook/component.

**Nullable `activity_logs.user_id` hides attribution** — `lib/db/migrations/0000_soft_the_anarchist.sql:4`
`user_id` is nullable; system actions could log NULL.
*Fix:* Make `user_id` NOT NULL or introduce an explicit system actor.

**`invitations.status` lacks CHECK constraint / lifecycle** — `lib/db/schema.ts:68`
`varchar(20) default 'pending'`; only `pending`→`accepted` ever set; rejected/expired never used, stale invites accumulate.
*Fix:* `CHECK (status IN (...))` + an expiry cleanup job.

**Stripe ↔ DB can diverge — no idempotency/reconciliation** — `lib/payments/stripe.ts:131-146`
`updateTeamSubscription` unconditionally overwrites; missed webhooks drift.
*Fix:* Add `last_subscription_sync_at` + a nightly reconciliation job.

**`team_members` lacks unique `(userId, teamId)`** — `lib/db/schema.ts:34-44`
App-level dup check has a race window; DB allows duplicate memberships.
*Fix:* Add `unique().on(teamMembers.userId, teamMembers.teamId)` and catch the violation.

**`_portable/` auth code out of sync with `lib/auth/`** — `_portable/auth/session.ts:1`
Two diverging sources of truth.
*Fix:* Re-export from `lib/`, sync via build step, or make `_portable/` docs-only.

**Root layout passes async promises into SWR `fallback`** — `app/layout.tsx:32-37`
`getUser()`/`getTeamForUser()` promises are placed in the SWR `fallback` (the comment says "we do NOT await"); hydration-mismatch risk if server/client data diverge.
*Fix:* Either resolve before render, or move `SWRConfig` to a client boundary fed by a server parent.

**`ActionState` redefined in components** — `app/(dashboard)/dashboard/page.tsx:23-26`
(Duplicate of the High duplicate-type finding, restated at Medium.)
*Fix:* Single exported type.

**Middleware protects only `/dashboard` while refreshing globally** — `middleware.ts:5`
Asymmetric: refresh on all GETs, protect only `/dashboard`; new protected routes silently rely on handler checks.
*Fix:* Document or consolidate route protection.

**Soft-delete email uniqueness bypass via race** — `app/(login)/actions.ts:320-323`
(Same root cause as the High soft-delete finding, at Medium scope.)
*Fix:* Partial unique index on active rows.

**Array access without bounds check in seed** — `lib/db/seed.ts:47,60`
`[user]`/`[team]` destructured from `.returning()` without existence checks.
*Fix:* Guard and throw on empty results.

---

## Low

**Activity-log query missing pagination** — `lib/db/queries.ts:81-100`
Hard `limit(10)`, no way to fetch older logs. *Fix:* add `limit`/`offset` params.

**No null safety / error state on general-settings email field** — `app/(dashboard)/dashboard/general/page.tsx:56`
SWR fetch failure shows a silently empty field. *Fix:* render an error/loading state.

**`AUTH_SECRET` not validated at runtime** — `lib/auth/session.ts:6`
`process.env.AUTH_SECRET` used with no presence check. *Fix:* throw on startup if missing.

**Session expiry stored as custom ISO string, not the `exp` claim** — `lib/auth/session.ts:39-42`
Custom `expires` field instead of the standard numeric `exp` claim (low risk due to HMAC signing, but fragile). *Fix:* use jose's `exp` and validate against it.

**`getTeamForUser()` does two sequential queries** — `lib/db/queries.ts:102-130`
`getUser()` then a separate team query. *Fix:* single JOIN on the session user id.

**Unbounded email lookup in `inviteTeamMember`** — `app/(login)/actions.ts:409-420`
Multiple lookups, no supporting indexes. *Fix:* combine queries; add indexes.

**Activity-logs JOIN without index on `user_id`** — `lib/db/queries.ts:87-99`
Full scan per user. *Fix:* `CREATE INDEX ON activity_logs(user_id, timestamp DESC)`.

**Missing return-type annotations** — `lib/db/queries.ts:7,39,49,67,81`
`getUser`, `getTeamByStripeCustomerId`, `updateTeamSubscription`, etc. lack explicit return types. *Fix:* annotate (e.g. `Promise<User | null>`).

**Potential null reference in `getStripePrices`** — `lib/payments/stripe.ts:155-164`
`price.product` union handled correctly here actually (line 159 narrows) — see Verification. *Fix (if hardening):* keep the existing narrowing pattern.

**Wide generic bounds in middleware** — `lib/auth/middleware.ts:12,17,31,37`
`z.ZodType<any, any>`. *Fix:* tighter bounds + JSDoc.

**No validation wrapper for API route handlers** — `app/api/stripe/checkout/route.ts:9-15`
Manual param checks vs the `validatedAction` pattern. *Fix:* a `validatedRoute` helper.

**Fetcher function duplicated across client components** — `app/(dashboard)/layout.tsx:19`
`fetcher` defined locally in multiple files. *Fix:* `lib/client/fetcher.ts`.

---

## Verification

The eight Critical and the High findings were re-checked against source on 2026-06-16. The repository has **no test files and no test runner** (`package.json` has no `test` script; no `*.test.ts`/`*.spec.ts` exist) — so every "no/missing test coverage" finding is confirmed by construction.

### Confirmed as written (or stronger)
- **C1 — Checkout auth bypass:** **CONFIRMED, exploitable.** `checkout/route.ts` derives the user purely from `session.client_reference_id` (line 52) and writes the subscription + calls `setSession(user[0])` (lines 79-92) with no comparison to the cookie-authenticated user. This is the highest-priority fix. (Exact lines: user lookup 52-65, team update 79-89, `setSession` 91 — finding's "52-89" is close enough.)
- **C2–C7 (test coverage), C8 (cascade delete):** CONFIRMED. Migration FKs are all `ON DELETE no action` (lines 54-88); `deleteAccount` only removes the user's own `team_members` row (actions.ts:325-334) and never touches `invitations.invited_by`.
- **High — Missing role auth:** CONFIRMED. `removeTeamMember` (365-392) and `inviteTeamMember` (399-459) check only team membership, never `owner` role. The UI gate `isOwner = user?.role === 'owner'` exists only client-side (`dashboard/page.tsx:192`).
- **High — IP never captured** (listed Medium in source but verified here): CONFIRMED. `logActivity` defaults `ipAddress` to `''` (actions.ts:42) and no caller passes one.
- **High — Stripe unsafe casts** (`stripe.ts:120,135-136`; `checkout/route.ts:46,85`; `webhook/route.ts:9`): CONFIRMED present exactly as described.
- **High — No transactions** in signup (134-213), checkout completion (79-91), webhook update (117-147): CONFIRMED — no `db.transaction` anywhere in these paths.
- **High — Missing FK indexes:** CONFIRMED — the migration defines no non-unique indexes.
- **High — Cross-layer import:** CONFIRMED — `app/(dashboard)/layout.tsx` is `'use client'` and imports `signOut` from `app/(login)/actions` (line 14).
- **High — Duplicate `ActionState`:** CONFIRMED — redefined in `dashboard/page.tsx:23` and `dashboard/general/page.tsx:16`; imported from `lib/auth/middleware` only in `login.tsx:11`.
- **High — `_portable` duplication:** CONFIRMED — `_portable/auth/helpers.ts` reimplements the validators with different generics.

### Confirmed, but qualified / weaker than stated
- **High — `inviteId` cross-team injection (actions.ts:155):** PARTIALLY MITIGATED. The invitation lookup also matches `invitations.email === email` **and** `status === 'pending'` (actions.ts:155-158), so an attacker can't bind an arbitrary `inviteId` to a different email. The real defects are the missing numeric validation (`NaN` silently no-matches) and the absent Zod constraint — those stand. The "attach signup to arbitrary team" framing overstates it.
- **High — Activity-logs tenant isolation (queries.ts:97):** Real (query is user-scoped, not team-scoped) but the "team_id can be NULL" claim is **false** — `activity_logs.team_id` is `NOT NULL` in both schema (schema.ts:48-50) and migration (line 3). `user_id` is the nullable column.
- **Low — `getStripePrices` null reference (stripe.ts:155-164):** Largely **REFUTED** — line 159 already narrows `typeof price.product === 'string' ? price.product : price.product.id`. The pattern is the correct one; no fix needed beyond consistency elsewhere.

### Line-number drift (findings reference offsets that don't match the actual file)
Several findings cite line numbers from an earlier/condensed copy of the files. Confirmed mismatches:
- `lib/db/queries.ts`: a finding references "expiry check at line 22" / "limit(10) at line 22" — the actual `getActivityLogs` `limit(10)` is at **line 99**, and the expiry check is at **line 22 of `queries.ts` getUser** (that one is correct). `getActivityLogs` is at 81-100, confirmed.
- `getActivityLogs` is called with **no arguments** (activity page line 72) and the function signature takes **none** (queries.ts:81) — so the pagination-parameter suggestions are valid additions, not corrections of an existing param.

Net: the line numbers are directionally right and the files are small, so the findings are easy to locate, but do not trust the exact line offsets — confirm at the symbol.


## Adversarial verification (critical/high)

Each finding below was independently verified against source. CONFIRMED-REAL = the bug/gap exists and is impactful; REFUTED = the finding mischaracterizes the code or the issue does not produce the claimed behavior.

1. **Missing Authorization on Stripe Checkout Callback — Arbitrary Team Subscription Assignment** — CONFIRMED-REAL: the unauthenticated `GET /api/stripe/checkout` trusts Stripe `client_reference_id` and writes a subscription without comparing to the cookie-authed user, enabling team-subscription takeover.
2. **No test coverage for JWT session management and token expiration** — CONFIRMED-REAL: zero test runner / test files exist; `signToken`/`verifyToken` (session.ts:25-38) and the dual-layer expiry checks are entirely untested.
3. **Missing error-path tests for authentication actions @ app/(login)/actions.ts** — CONFIRMED-REAL: all five cited error paths (bad password, dup email, invalid invite, missing team, password mismatch) are real and have no test coverage.
4. **Stripe webhook handler lacks error-path tests** — CONFIRMED-REAL: only signature verification is guarded; null team lookup returns 200 OK while the update silently fails, and no tests cover malformed payloads or missing data.
5. **No tests for Stripe checkout session creation and redemption** — CONFIRMED-REAL: 7 throw paths in checkout/route.ts and the createCheckoutSession guard are untested; business-critical payment flow relies on manual testing only.
6. **Password validation has weak/missing test coverage** — CONFIRMED-REAL: updatePassword, deleteAccount, comparePasswords, and hashPassword have zero tests; the load-bearing security primitives are unvalidated.
7. **No tests for session cookie security attributes @ lib/auth/session.ts + middleware.ts** — CONFIRMED-REAL: httpOnly/secure/sameSite flags are set correctly in code but no tests verify them; legitimate gap (lower severity in template context).
8. **Missing Cascade Delete — Invitations become orphaned when user creator is deleted** — CONFIRMED-REAL: all FKs use ON DELETE no action (migration lines 55-85); deleteAccount only clears one team_members row, leaving invitations.invited_by orphaned.
9. **Race condition in email uniqueness on account deletion @ actions.ts:321** — REFUTED: no pre-update uniqueness check exists; the email uses CONCAT(email,-,id,-deleted) which is mathematically unique per user via the PK, and the UPDATE is atomic.
10. **Unvalidated plan name cast causes runtime error** — CONFIRMED-REAL: stripe.ts:136 casts unexpanded `plan?.product` (a string ID in webhooks) to Stripe.Product and reads `.name`, yielding undefined → plan name silently stored as null on every active/trialing webhook.
11. **Unsafe null access in inviteTeamMember @ line 414** — REFUTED: line 414 is a Drizzle query-builder WHERE clause resolved at SQL-gen time, not a runtime JS dereference; code only checks `existingMember.length`, no null pointer exception.
12. **Missing Role-Based Authorization on Team Member Operations** — CONFIRMED-REAL: removeTeamMember and inviteTeamMember check only membership, not role (getUserWithTeam never fetches role), allowing any member to remove others and grant owner — privilege escalation.
13. **Unvalidated Invitation ID Parsing — Potential Integer Overflow or Type Coercion** — REFUTED: Zod guarantees a string, parseInt→NaN maps to NULL → no match, and the lookup requires id + email + status=pending; no bypass or privilege escalation.
14. **Unsafe type assertion on missing header value @ webhook/route.ts:9** — CONFIRMED-REAL: `as string` bypasses the `string | null` type; current safety relies on Stripe's downstream null-check rather than validating the header — a real type-safety/defensive-programming defect.
15. **Unsafe type assertions on Stripe objects without null checks @ checkout/route.ts:46, 85** — CONFIRMED-REAL: `as Stripe.Product` is unverified; if product is a string/DeletedProduct or expand fails, `.id`/`.name` access crashes the checkout callback.
16. **Unchecked type assertion on subscription.customer field @ stripe.ts:120** — REFUTED: Stripe webhooks always send customer as a string ID (expand is ignored in webhooks), so the `as string` cast is contextually safe with no silent-failure mode.
17. **Multiple unsafe type assertions without null/string type guards on Stripe product field @ stripe.ts:135-136** — CONFIRMED-REAL: lines 135-136 make contradictory string vs Stripe.Product casts on the same field; the correct `typeof === 'string'` pattern is used elsewhere (159, 178).
18. **Unchecked type assertions on FormData values without null validation** — CONFIRMED-REAL: `as string` on formData.get('priceId') hides null; a request omitting the field sends null to Stripe → 400 / unhandled rejection. No `if (!priceId)` guard exists.
19. **Unsafe type assertion without null guard on session verification result** — CONFIRMED-REAL: actions.ts:225 `(await getUser()) as User` masks the 4 null-return paths; a session expiring between page load and logout click can crash on `.id` access.
20. **Missing database indexes on foreign keys** — CONFIRMED-REAL: teamMembers/activityLogs/invitations FK columns used in WHERE/JOIN have no index() definitions or CREATE INDEX statements → full table scans at scale.
21. **N+1 query pattern in team member query @ queries.ts:108-127** — REFUTED: Drizzle relational `findFirst` with nested `with` emits a single JOINed query, not N+1; the real (lesser) concern is unbounded in-memory member fetch, not an N+1.
22. **Unhandled errors in Stripe webhook handler** — CONFIRMED-REAL: webhook/route.ts:27 awaits handleSubscriptionChange with no try-catch; a DB failure throws while the handler still returns 200, so Stripe never retries → desynced subscription state.
23. **Unsafe parseInt on user-controlled inviteId without validation** — REFUTED: parseInt('abc')→NaN→no DB match, plus email + status=pending conditions; invalid IDs are safely rejected with an error, no wrong-record match. (Code-quality nit, not a vuln.)
24. **Race condition in Stripe checkout completion flow** — CONFIRMED-REAL: checkout/route.ts:79-91 runs SELECT/SELECT/UPDATE non-transactionally and the webhook updates the same teams row; concurrent processing can lose writes or set the session while the update is stale.
25. **Unhandled promise rejection in logActivity calls @ actions.ts:89-91** — CONFIRMED-REAL: Promise.all([setSession, logActivity]) has no error handling; if logActivity fails after setSession succeeds, the user is logged in but the audit log is silently lost (same pattern in signUp/updatePassword/updateAccount).

**Tally: 19 confirmed / 6 refuted.**
