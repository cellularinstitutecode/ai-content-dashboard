// web/lib/public-base.ts
// The app's own public https origin.
//
// Nothing in this repo has ever needed to know its own address: every URL it
// produces belongs to somebody else — Drive, Supabase, Metricool. The signed
// media route is the first thing that must hand an outside service a link
// back HERE, and there is no framework value that reliably says where "here"
// is. Two copies of this app run at once (Vercel and the Dokploy container,
// deploy/DOKPLOY.md), and the bytes should come from the one with no response
// ceiling — so WHICH copy serves the media is a decision, not a lookup.
//
// Pure but for process.env, so the test runner reads this file directly.

/** No address resolves. Thrown, never papered over: a guessed host is a dead post. */
export class MediaBaseUnresolved extends Error {
  readonly code = 'no_public_base' as const;
  constructor(message: string) {
    super(message);
    this.name = 'MediaBaseUnresolved';
  }
}

export const NO_PUBLIC_BASE_MESSAGE =
  'This deployment does not know its own public address, so it cannot give Metricool a link to the video. '
  + 'Set PUBLIC_MEDIA_BASE_URL to the https origin that serves the media — the Dokploy copy, see deploy/DOKPLOY.md '
  + '— for example https://media.example.com.';

/** The origin of a value that may be a bare host, a URL, or nonsense. */
function originOf(raw: string | null | undefined): string | null {
  const v = String(raw || '').trim();
  if (!v) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(v) ? v : 'https://' + v);
    // Plain http is refused rather than upgraded. Metricool fetches this from
    // outside; an http link is refused or silently downgraded by half the
    // internet, and the failure looks exactly like "the video is broken".
    // localhost is the one exception, so `npm run dev` still works.
    if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * Where a media URL points, most specific first.
 *
 *  1. PUBLIC_MEDIA_BASE_URL — the one that matters, and deliberately SEPARATE
 *     from the app's own address. A Vercel function streams a large body
 *     through AWS Lambda, which throttles response streaming hard and caps the
 *     payload; the clinic's reels run 96 MB to 1.8 GB, and lib/metricool.ts
 *     only waits so long for Metricool to pull one. The Dokploy container is a
 *     long-lived Node server with no such ceiling. So the Vercel copy should
 *     mint URLs pointing at Dokploy: control plane there, bytes here.
 *  2. PUBLIC_BASE_URL — the app's address, when both are the same host.
 *  3. The origin of OPUS_WEBHOOK_URL. That variable already means "this app's
 *     public address" (lib/opus.ts), proven by something external reaching it.
 *  4. VERCEL_PROJECT_PRODUCTION_URL — the STABLE production hostname. Not
 *     VERCEL_URL, which is the per-deployment preview host: a URL minted
 *     against it dies with the next push, weeks after a draft was written.
 *     Last, because of (1) — and the health check says so out loud.
 *  5. The incoming request, when the caller has one.
 */
export function publicBase(req?: { headers: { get(name: string): string | null } }): string {
  const found = publicBaseSource();
  if (found.ok) return found.base;

  if (req) {
    const host = req.headers.get('x-forwarded-host') || req.headers.get('host');
    const proto = req.headers.get('x-forwarded-proto') || 'https';
    const fromReq = originOf(proto + '://' + String(host || ''));
    if (fromReq) return fromReq;
  }

  throw new MediaBaseUnresolved(NO_PUBLIC_BASE_MESSAGE);
}

export type BaseSource =
  | { ok: true; base: string; from: 'PUBLIC_MEDIA_BASE_URL' | 'PUBLIC_BASE_URL' | 'OPUS_WEBHOOK_URL' | 'VERCEL_PROJECT_PRODUCTION_URL' }
  | { ok: false };

/** Would publicBase() answer from the environment, and from which variable? */
export function publicBaseSource(): BaseSource {
  const chain = [
    ['PUBLIC_MEDIA_BASE_URL', process.env.PUBLIC_MEDIA_BASE_URL],
    ['PUBLIC_BASE_URL', process.env.PUBLIC_BASE_URL],
    ['OPUS_WEBHOOK_URL', process.env.OPUS_WEBHOOK_URL],
    ['VERCEL_PROJECT_PRODUCTION_URL', process.env.VERCEL_PROJECT_PRODUCTION_URL],
  ] as const;
  for (const [from, raw] of chain) {
    const base = originOf(raw);
    if (base) return { ok: true, base, from };
  }
  return { ok: false };
}
