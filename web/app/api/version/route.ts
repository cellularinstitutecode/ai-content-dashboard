// web/app/api/version/route.ts
// Lightweight build-version endpoint. The client polls this and, when the
// deployed commit changes, prompts the user to refresh — ending the
// stale-cached-bundle problem where an old JS bundle keeps running after a deploy.
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const version =
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.NEXT_PUBLIC_BUILD_ID ||
    'dev';
  return NextResponse.json(
    { version },
    { headers: { 'cache-control': 'no-store, max-age=0' } },
  );
}
