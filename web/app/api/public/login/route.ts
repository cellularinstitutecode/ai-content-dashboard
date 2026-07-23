import { NextResponse } from 'next/server';

const TEMP_PASSWORD = process.env.TEMP_PASSWORD || '123456789';

export async function POST(request: Request) {
  let body: { email?: string; password?: string } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const email = (body.email || '').trim();
  const password = (body.password || '').trim();

  if (!email) {
    return NextResponse.json({ error: 'email_required' }, { status: 400 });
  }
  if (password !== TEMP_PASSWORD) {
    return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  // Temporary auth cookie consumed by middleware. httpOnly so it is not readable from JS.
  res.cookies.set({
    name: 'app_auth',
    value: TEMP_PASSWORD,
    httpOnly: true,
    sameSite: 'lax',
    secure: true,
    path: '/',
    maxAge: 60 * 60 * 24 * 7
  });
  return res;
}
