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
  // The Sources section embeds the team's Google Sheets in their own editor.
  "frame-src 'self' https://docs.google.com https://drive.google.com",
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
  // The brand-card route reads font files from disk at request time (the
  // licensed brand faces when present, the open stand-ins otherwise). File
  // tracing only follows imports, so the fonts are named here or the deployed
  // function would have no type to set the cards in.
  // ffmpeg-static must NOT be bundled into the server chunk.
  //
  // Its index.js computes the binary's location as path.join(__dirname,
  // 'ffmpeg'). Bundled, __dirname becomes the chunk's own directory as it
  // stood AT BUILD TIME, so the deployed function looked for the binary at
  // /ROOT/web/node_modules/ffmpeg-static/ffmpeg — a path that exists on the
  // build machine and nowhere in the Lambda. The file was traced in correctly
  // the whole time; the code was looking in the wrong place for it.
  //
  // Left external, it stays a real require() out of node_modules at runtime
  // and __dirname is the directory the file actually sits in. (The binary
  // itself is no longer traced in at all — see outputFileTracingExcludes —
  // so in production that path is absent and lib/audio-extract.ts fetches
  // the binary instead; the package still has to resolve for that decision
  // to be made in the right place.)
  serverExternalPackages: ['ffmpeg-static'],
  // File tracing follows imports, and the fonts are files rather than imports:
  // the brand-card route reads them from disk at request time (the licensed
  // brand faces when present, the open stand-ins otherwise). Named here, or
  // the deployed function would have no type to set cards in.
  outputFileTracingIncludes: {
    '/api/drafts/card': ['./public/fonts/**/*'],
  },
  // What the functions must NOT carry. Vercel stores every function of every
  // deployment it keeps, and the free plan's Function Storage allowance is
  // 10 GB — which ran out, because:
  //
  //  - ffmpeg-static's binary is 77 MB, and tracing copied it into every
  //    function whose imports reached lib/audio-extract.ts: six of them, on
  //    every push. It is now excluded everywhere and fetched at first use
  //    instead (lib/audio-extract.ts resolveFfmpeg, lib/ffmpeg-source.ts).
  //  - sharp and libvips (54 MB) were traced into the two card routes through
  //    Next's image optimiser, which those routes never call — ImageResponse
  //    renders with @vercel/og's resvg and yoga wasm, which stay traced.
  //
  // Keys are route globs (picomatch): '/**' is every route.
  outputFileTracingExcludes: {
    '/**': ['./node_modules/ffmpeg-static/ffmpeg'],
    '/api/drafts/card': ['./node_modules/sharp/**', './node_modules/@img/**'],
    '/api/brand/fonts': ['./node_modules/sharp/**', './node_modules/@img/**'],
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
