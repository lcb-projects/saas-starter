# SaaS Starter

Next.js SaaS template with authentication, Stripe payments, and team management.

## Tech Stack

- **Framework**: Next.js 15 (App Router, Turbopack)
- **Database**: PostgreSQL + Drizzle ORM
- **Payments**: Stripe (checkout, webhooks, customer portal)
- **UI**: shadcn/ui + Tailwind CSS 4 + Radix UI
- **Auth**: Email/password with JWTs (jose) stored in cookies
- **Validation**: Zod

## Dev Commands

```bash
bun install              # Install dependencies
bun run dev              # Start dev server (Turbopack) on :3000
bun run build            # Production build
bun run start            # Start production server
bunx tsx lib/db/setup.ts # Set up .env file
bun run db:generate      # Generate Drizzle migrations
bun run db:migrate       # Run migrations (drizzle-kit)
bun run db:seed          # Seed default user/team
bun run db:studio        # Open Drizzle Studio
```

## Key Files

```
app/
  (dashboard)/           # Protected dashboard routes
    dashboard/           # Settings: general, security, activity
    pricing/             # Stripe checkout integration
  (login)/               # Auth routes (sign-in, sign-up)
    actions.ts           # Server actions for auth
  api/stripe/            # Stripe checkout + webhook routes
  api/team/              # Team CRUD API
  api/user/              # User API
  layout.tsx             # Root layout
components/ui/           # shadcn/ui components
lib/
  auth/session.ts        # JWT session management
  auth/middleware.ts      # Route protection middleware
  db/schema.ts           # Drizzle schema (users, teams, activity)
  db/queries.ts          # Database query functions
  db/drizzle.ts          # DB connection
  payments/stripe.ts     # Stripe client config
  payments/actions.ts    # Payment server actions
middleware.ts            # Global Next.js middleware
drizzle.config.ts        # Drizzle Kit config
```

## Environment Variables

```
BASE_URL=http://localhost:3000
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
POSTGRES_URL=
AUTH_SECRET=
```

## Stripe Testing

- Webhook forwarding: `stripe listen --forward-to localhost:3000/api/stripe/webhook`
- Test card: `4242 4242 4242 4242`, any future date, any CVC

## Default Seed User

- Email: `test@test.com`
- Password: `admin123`

## Conventions

- Path alias: `@/*` maps to project root
- RBAC: Owner and Member roles per team
- Activity logging on all user events
