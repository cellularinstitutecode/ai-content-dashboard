# ai-content-dashboard

AI-powered content generation and scheduling dashboard.

The application lives in the [`web/`](./web) subfolder — a Next.js 14 (App Router) app that generates multi-channel content packs (Instagram, Facebook, LinkedIn, blog) via Anthropic Claude or OpenAI, schedules them through Metricool, creates video clips via OpusClip, and persists drafts/posts with Supabase (Postgres + RLS).

## Getting started

See [`web/README.md`](./web/README.md) for full setup, environment variables, and deployment instructions.

```bash
cd web
cp .env.example .env.local   # fill in real values
npm install
npm run dev
```

## Structure

- `web/` — the Next.js application (frontend + API routes)
- `index.html` — the original static prototype (superseded by `web/`)
