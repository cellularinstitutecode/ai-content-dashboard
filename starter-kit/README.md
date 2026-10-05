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

The zip matches the dashboard on `main` **through #398**. Recent changes it includes:

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
- **#395**: video rows that already have copy get the advertising notice (when
  a permit is set) and a researched REF line, so they can be sent.
- **#396**: video copy with no health claim needs no REF line and can be sent
  as it is.
- **#397**: a health claim is an assertion, not a topic. Copy that only names
  a therapy or asks questions sends without a REF; copy that asserts an
  effect, a safety statement, a percentage or an appeal to studies still
  needs its citation. The composer, the send route, the nightly video queue
  and the approve step all use this one rule. The composer also has a "Find
  and add the citation" action.
- **#398**: the composer's green check line says what is true. A post with
  no health claim reads "No scientific reference — none needed, this post
  makes no health claim." instead of claiming a reference is present. (In
  this template the advertising notice is only mentioned when a permit
  number is set.)

When more changes land on `main`, the zip has to be re-synced (it does not
update itself).
