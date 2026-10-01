# Starter kit — blank copy of the dashboard

`ai-content-dashboard-blank.zip` is a complete, reusable copy of this
dashboard with everything specific to this deployment removed:

- no API keys or secrets (every key in `web/.env.example` is blank or a placeholder)
- no account ids (Metricool, Google Sheets / Drive, advertising permit) — all read from env, default empty
- no brand: Brand Brain starts empty, neutral grey default palette, no logo,
  no brand fonts, no house hashtag, timezone defaults to UTC
- the built-in weekly strategy is a generic example to replace
- fresh history: the zip carries no `.git`

Unzip it, push it to a new GitHub repository, and follow its `SETUP.md`.
Lint, typecheck, all unit tests and the production build pass on it as shipped.

This folder is only a download. Nothing in it is built or deployed with the
dashboard, and nothing in the dashboard depends on it.
