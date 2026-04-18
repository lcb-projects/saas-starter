# SaaS Starter Agent Instructions

Read `CLAUDE.md` first. This repo is a Next.js SaaS template with auth, Stripe payments, team management, and Drizzle/Postgres.

## Commands

```bash
bun install
bun run dev
bun run build
bun run db:generate
bun run db:migrate
bun run db:seed
```

## Rules

- Use `bun` only.
- Do not change auth, Stripe, webhooks, or team/RBAC behavior without focused verification.
- Never commit live Stripe keys, database URLs, or auth secrets.
- Run migrations/generation only when schema changes are intended.

