// web/app/api/client-errors/route.ts
// Lightweight client-error sink. The browser posts uncaught errors here so they
// land in the server (Vercel) logs — giving visibility into client-side failures
// without adding an external observability dependency or secret.
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const message = String((body && body.message) || '').slice(0, 500);
    const stack = String((body && body.stack) || '').slice(0, 2000);
    const path = String((body && body.path) || '').slice(0, 200);
    if (message) {
      // Structured line so it is easy to grep in Vercel logs.
      console.error('[client-error]', JSON.stringify({ message, path, stack }));
    }
    return NextResponse.json({ ok: true });
  } catch {
    // Never let the error sink itself throw.
    return NextResponse.json({ ok: false });
  }
}
