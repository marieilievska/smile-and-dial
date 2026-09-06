# Smile & Dial

Internal AI calling platform for Referrizer — outbound and inbound AI voice
calls (ElevenLabs agents + Twilio) with lead management, scoring, callbacks,
DNC, analytics, cost tracking, and Calendly / Close integrations.

The app is the specification: the code, the migrations and the agent prompts
in docs/agent-prompts are the source of truth for every architectural and
design decision.

## Tech stack

- **Framework:** Next.js 16 (App Router, TypeScript)
- **Styling:** Tailwind CSS v4 + shadcn/ui, design tokens in src/app/globals.css
- **Database / auth:** Supabase (Postgres, RLS, Supabase Auth)
- **Testing:** Vitest unit tests (`npm test`); changes are verified with tsc, eslint and a production build before merging
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
| `npm test`       | Run the Vitest unit tests         |

## Development workflow

The project is built feature by feature, one pull request each, with Vitest
unit tests covering the new behaviour. Commits are checked locally by Husky +
lint-staged (ESLint and Prettier).
