import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaBaseUnresolved, publicBase, publicBaseSource } from './public-base.ts';

const KEYS = ['PUBLIC_MEDIA_BASE_URL', 'PUBLIC_BASE_URL', 'OPUS_WEBHOOK_URL', 'VERCEL_PROJECT_PRODUCTION_URL'] as const;
function only(set: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(set)) process.env[k] = v;
}

test('the media host wins over every other address', () => {
  only({
    PUBLIC_MEDIA_BASE_URL: 'https://media.example.com',
    PUBLIC_BASE_URL: 'https://app.example.com',
    OPUS_WEBHOOK_URL: 'https://opus.example.com/api/opus/webhook',
    VERCEL_PROJECT_PRODUCTION_URL: 'app.vercel.app',
  });
  assert.equal(publicBase(), 'https://media.example.com');
  assert.deepEqual(publicBaseSource(), { ok: true, base: 'https://media.example.com', from: 'PUBLIC_MEDIA_BASE_URL' });
});

test('each rung wins over the ones below it', () => {
  only({ PUBLIC_BASE_URL: 'https://app.example.com', OPUS_WEBHOOK_URL: 'https://opus.example.com/x', VERCEL_PROJECT_PRODUCTION_URL: 'a.vercel.app' });
  assert.equal(publicBase(), 'https://app.example.com');
  only({ OPUS_WEBHOOK_URL: 'https://opus.example.com/x', VERCEL_PROJECT_PRODUCTION_URL: 'a.vercel.app' });
  assert.equal(publicBase(), 'https://opus.example.com');
  only({ VERCEL_PROJECT_PRODUCTION_URL: 'a.vercel.app' });
  assert.equal(publicBase(), 'https://a.vercel.app');
});

test('the webhook URL contributes its origin, not its path', () => {
  only({ OPUS_WEBHOOK_URL: 'https://app.example.com/api/opus/webhook' });
  assert.equal(publicBase(), 'https://app.example.com');
});

test('a bare hostname is read as https', () => {
  only({ PUBLIC_MEDIA_BASE_URL: 'media.example.com' });
  assert.equal(publicBase(), 'https://media.example.com');
});

test('plain http is refused and falls through — except on localhost', () => {
  only({ PUBLIC_MEDIA_BASE_URL: 'http://media.example.com', PUBLIC_BASE_URL: 'https://app.example.com' });
  assert.equal(publicBase(), 'https://app.example.com');
  only({ PUBLIC_MEDIA_BASE_URL: 'http://localhost:3000' });
  assert.equal(publicBase(), 'http://localhost:3000');
});

test('a malformed value falls through instead of throwing', () => {
  only({ PUBLIC_MEDIA_BASE_URL: 'not a url at all', PUBLIC_BASE_URL: 'https://app.example.com' });
  assert.equal(publicBase(), 'https://app.example.com');
});

test('with nothing set and no request, it throws and names the variable', () => {
  only({});
  assert.deepEqual(publicBaseSource(), { ok: false });
  assert.throws(() => publicBase(), (e: unknown) => {
    assert.ok(e instanceof MediaBaseUnresolved);
    assert.equal((e as MediaBaseUnresolved).code, 'no_public_base');
    assert.match((e as Error).message, /PUBLIC_MEDIA_BASE_URL/);
    return true;
  });
});

test('the request is the last resort, and the forwarded host wins', () => {
  only({});
  const headers = new Map([['x-forwarded-proto', 'https'], ['x-forwarded-host', 'media.example.com'], ['host', 'internal:3000']]);
  assert.equal(publicBase({ headers: { get: (n: string) => headers.get(n) ?? null } }), 'https://media.example.com');
});
