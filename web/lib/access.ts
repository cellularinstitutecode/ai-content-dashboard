// Shared tenant-access allowlists. Kept in one place so every entry point
// (middleware, auth callback, Metricool routes) enforces the SAME rule and the
// list can't drift between a server check and a client-only check.

// Emails permitted to hold a session in this deployment. Server-side only —
// NEVER trust NEXT_PUBLIC_ALLOWED_EMAILS alone (it ships in the JS bundle and a
// user can bypass it by calling signInWithPassword directly).
export const ALLOWED_EMAILS: string[] = (
  process.env.ALLOWED_EMAILS ||
  process.env.NEXT_PUBLIC_ALLOWED_EMAILS ||
  'cellularhopeinstitute@gmail.com'
)
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

export function isAllowedEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  // Empty allowlist = deny-all rather than allow-all, so a misconfigured env
  // can never silently open the app to everyone.
  if (ALLOWED_EMAILS.length === 0) return false;
  return ALLOWED_EMAILS.includes(email.toLowerCase());
}

// Metricool brand profiles this deployment may read or post into. The shared
// org token can reach several, so blogId is never taken on trust from a request.
const DEFAULT_BLOG_ID = process.env.METRICOOL_BLOG_ID || '4308292';
export const ALLOWED_BLOG_IDS = new Set(
  (process.env.METRICOOL_BLOG_IDS || DEFAULT_BLOG_ID)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean),
);

export function isAllowedBlogId(blogId: string | null | undefined): boolean {
  return !!blogId && ALLOWED_BLOG_IDS.has(String(blogId));
}

export { DEFAULT_BLOG_ID };
