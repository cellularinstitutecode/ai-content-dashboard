'use client';

import { useEffect, useState } from 'react';
import { createBrowserClient } from '@supabase/ssr';
import { safeNextPath } from '@/lib/safe-redirect';

const ALLOWED = (process.env.NEXT_PUBLIC_ALLOWED_EMAILS || 'cellularhopeinstitute@gmail.com')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

function getSupabase() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

// The server bounces people back here with ?error=... . Until this existed the
// page ignored it entirely, so the most likely real-world failure - signing in
// with the wrong Google account, which browsers make easy when several are
// logged in - dumped the user on a blank form with no explanation. They try
// again, Google silently reuses the same account, and it looks broken.
const SIGN_IN_ERRORS: Record<string, string> = {
  not_allowed:
    'That account is not authorized for this dashboard. If you have more than one Google account, choose the Cellular Hope Institute one.',
  exchange_failed:
    'That sign-in link could not be completed. It may have expired or already been used — please try again.',
  missing_code:
    'The sign-in link was incomplete. Please start again from this page.',
};

export default function SignInPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [message, setMessage] = useState('');

  // Surface whatever the auth callback or middleware sent us back with.
  useEffect(() => {
    try {
      const code = new URLSearchParams(window.location.search).get('error');
      if (!code) return;
      setStatus('error');
      setMessage(SIGN_IN_ERRORS[code] || 'Sign-in did not complete. Please try again.');
    } catch {
      /* no query string to read */
    }
  }, []);

  function checkAllowed(normalized: string) {
    if (!ALLOWED.includes(normalized)) {
      setStatus('error');
      setMessage('This email is not authorized to access the dashboard.');
      return false;
    }
    return true;
  }

  async function handlePasswordSignIn(e: React.FormEvent) {
    e.preventDefault();
    setStatus('sending');
    setMessage('');

    const normalized = email.trim().toLowerCase();
    if (!checkAllowed(normalized)) return;

    const supabase = getSupabase();
    const { error } = await supabase.auth.signInWithPassword({
      email: normalized,
      password,
    });

    if (error) {
      setStatus('error');
      setMessage(error.message);
      return;
    }

    // Honor the ?next= the middleware set when it bounced the user here —
    // same-origin relative paths only, so it can't be abused as an open redirect.
    let next = '/';
    try {
      const q = new URLSearchParams(window.location.search).get('next');
      next = safeNextPath(q, window.location.origin);
    } catch {}
    window.location.href = next;
  }

  async function handleMagicLink() {
    setStatus('sending');
    setMessage('');

    const normalized = email.trim().toLowerCase();
    if (!checkAllowed(normalized)) return;

    const supabase = getSupabase();
    const { error } = await supabase.auth.signInWithOtp({
      email: normalized,
      options: { emailRedirectTo: `${location.origin}/auth/callback` },
    });

    if (error) {
      setStatus('error');
      setMessage(error.message);
      return;
    }

    setStatus('sent');
    setMessage('Check your inbox for the sign-in link.');
  }

  async function handleGoogle() {
    setStatus('sending');
    setMessage('');

    const supabase = getSupabase();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${location.origin}/auth/callback`,
        // Force the account chooser. Without it, a browser already signed into
        // a personal Google account silently reuses it on every attempt - so a
        // user rejected by the allowlist has no way to reach the right account
        // and just sees the same bounce over and over.
        queryParams: { prompt: 'select_account' },
      },
    });

    if (error) {
      setStatus('error');
      setMessage(error.message);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-[#050914] text-white px-4">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#0b1424] p-8 shadow-xl">
        <div className="mb-6 text-center">
          <div className="text-2xl font-semibold">AI Content Dashboard</div>
          <div className="mt-1 text-sm text-white/60">Cellular Hope Institute — sign in</div>
        </div>

        <form onSubmit={handlePasswordSignIn} className="space-y-4">
          <label className="block text-sm">
            <span className="text-white/70">Email address</span>
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@cellularhope.com"
              className="mt-1 w-full rounded-lg bg-[#07111f] border border-white/10 px-3 py-2 text-white placeholder-white/30 focus:outline-none focus:border-[#3b82f6]"
            />
          </label>

          <label className="block text-sm">
            <span className="text-white/70">Password</span>
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="mt-1 w-full rounded-lg bg-[#07111f] border border-white/10 px-3 py-2 text-white placeholder-white/30 focus:outline-none focus:border-[#3b82f6]"
            />
          </label>

          <button
            type="submit"
            disabled={status === 'sending'}
            className="w-full rounded-lg bg-[#3b82f6] hover:bg-[#2563eb] disabled:opacity-50 disabled:cursor-not-allowed py-2 font-medium transition"
          >
            {status === 'sending' ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <div className="my-4 flex items-center gap-3 text-white/30 text-xs">
          <div className="h-px flex-1 bg-white/10" />
          OR
          <div className="h-px flex-1 bg-white/10" />
        </div>

        <button
          type="button"
          onClick={handleGoogle}
          disabled={status === 'sending'}
          className="w-full rounded-lg bg-white text-[#1f2937] hover:bg-white/90 disabled:opacity-50 py-2 font-medium transition"
        >
          Sign in with Google
        </button>

        <button
          type="button"
          onClick={handleMagicLink}
          disabled={status === 'sending'}
          className="mt-3 w-full rounded-lg border border-white/10 bg-transparent hover:bg-white/5 disabled:opacity-50 py-2 font-medium transition"
        >
          Send magic link instead
        </button>

        {message && (
          <div
            className={`mt-4 rounded-lg px-3 py-2 text-sm ${
              status === 'error'
                ? 'bg-red-500/10 text-red-300 border border-red-500/20'
                : 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20'
            }`}
          >
            {message}
          </div>
        )}

        <div className="mt-6 text-center text-xs text-white/40">
          Access is restricted to authorized team members.
        </div>
      </div>
    </main>
  );
}
