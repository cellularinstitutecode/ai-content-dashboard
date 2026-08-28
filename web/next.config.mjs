/** @type {import('next').NextConfig} */

// The Supabase origin the browser legitimately talks to. Derived rather than
// hard-coded so the policy follows the deployment.
const SUPABASE_ORIGIN = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').origin;
  } catch {
    return '';
  }
})();

// Content-Security-Policy, shipped REPORT-ONLY on purpose.
//
// There are no XSS sinks in the app today - no dangerouslySetInnerHTML, no
// innerHTML, no eval - so this is defence in depth rather than a live fix. But
// the app renders model-generated text inside a session that can reach a live
// brand account, which is exactly the situation where a future sink is
// expensive. Report-only lets the realtime voice session, Supabase storage and
// the media hosts surface in violation reports before anything breaks; once the
// reports are quiet, rename the header to Content-Security-Policy.
//
// script-src carries 'unsafe-inline' because Next's App Router injects inline
// bootstrap scripts. Removing it means adopting a nonce in middleware - worth
// doing, and a separate change from turning the policy on at all.
const csp = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  // Ignored while the policy is report-only; X-Frame-Options: DENY above is
  // what actually blocks framing today. Kept so enforcing is a one-word change.
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline'",
  // app/layout.tsx loads a Google Fonts stylesheet, which then pulls font files
  // from a second host. Omitting these makes every page load report a violation
  // and would strip the app's typography the moment the policy is enforced.
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  // Generated hero images (Supabase Storage), video thumbnails, Metricool and
  // Drive assets. blob:/data: cover locally-rendered previews.
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  [
    'connect-src',
    "'self'",
    SUPABASE_ORIGIN,
    SUPABASE_ORIGIN ? SUPABASE_ORIGIN.replace(/^https:/, 'wss:') : '',
    // Realtime voice session: SDP exchange plus the live audio channel.
    'https://api.openai.com',
    'wss://api.openai.com',
  ]
    .filter(Boolean)
    .join(' '),
].join('; ');

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(self), geolocation=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'Content-Security-Policy-Report-Only', value: csp },
];

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Next 16 promoted this out of `experimental`.
  typedRoutes: true,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
