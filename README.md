# Smile & Dial

Internal AI calling platform for Referrizer — outbound and inbound AI voice
calls (ElevenLabs agents + Twilio) with lead management, scoring, callbacks,
DNC, analytics, cost tracking, and Calendly / Close integrations.

The full specification lives in [BUILD_PLAN.md](./BUILD_PLAN.md) and is the
source of truth for every architectural and design decision.

## Tech stack

- **Framework:** Next.js 16 (App Router, TypeScript)
- **Styling:** Tailwind CSS v4 + shadcn/ui, design tokens per BUILD_PLAN.md Section 19
- **Database / auth:** Supabase (Postgres, RLS, Supabase Auth)
- **Testing:** Playwright E2E, run on every pull request via GitHub Actions
- **Hosting:** Vercel

## Getting started

```bash
npm install
cp .env.example .env.local   # then fill in the Supabase credentials
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Authentication is
invite-only — there is no public signup. Use a seeded account to sign in.

## Scripts

| Script           | Purpose                           |
| ---------------- | --------------------------------- |
| `npm run dev`    | Start the development server      |
| `npm run build`  | Production build                  |
| `npm run start`  | Serve the production build        |
| `npm run lint`   | Run ESLint                        |
| `npm run format` | Format the codebase with Prettier |
| `npm test`       | Run the Playwright E2E suite      |

## Development workflow

The project is built phase by phase per BUILD_PLAN.md Section 17. Each step is
a single pull request that includes at least one Playwright test covering the
new behaviour. Commits are checked locally by Husky + lint-staged (ESLint and
Prettier).
