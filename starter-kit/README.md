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

## Up to date with

The zip matches the dashboard on `main` **through #394**. Recent changes it includes:

- **#392**: one button per repair on review cards. **Fix** repairs the copy and
  the picture; **Fix citation** repairs only the citation. The picture
  checker no longer flags good pictures, and the video notice has a close ×.
- **#393**: **Fix citation** searches for a supporting study first, then
  corrects the copy on every channel. It keeps time for the correction so the
  search can't use it all. If it still can't fix the citation, the card says
  what it searched and what it rewrote.
- **#394**: **Fix citation** only rewrites toward a study on the same subject
  as the post. When no relevant study exists, it drops the citation, turns the
  health claims into plain advice and asks you to read the post before
  approving. It never adds an unrelated study.

When more changes land on `main`, the zip has to be re-synced (it does not
update itself).
