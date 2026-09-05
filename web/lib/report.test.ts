// A vendor error body once carried the Semrush key into Vercel's logs. Every
// message and context string reportError writes is masked; this pins it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from './report.ts';

test('credentials of every shape the app handles are masked', () => {
  assert.equal(redact('key rejected: semrtkn-pat-AbCdEf123456_xyz'), 'key rejected: [redacted]');
  assert.equal(redact('https://www.semrush.com/users/countapiunits.html?key=0123456789abcdef0123456789abcdef'), 'https://www.semrush.com/users/countapiunits.html?key=[redacted]');
  assert.equal(redact('Authorization: Apikey semrtkn-pat-AbCdEf123456'), 'Authorization: Apikey [redacted]');
  assert.equal(redact('Bearer eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.abcdefghijklmnop'), 'Bearer [redacted]');
  assert.equal(redact('openai said sk-proj-abcdefghijklmnopqrstuvwxyz'), 'openai said [redacted]');
});

test('ordinary text is left alone', () => {
  const s = 'HTTP 403 from api.semrush.com for phrase_related (12 lines, 480 units)';
  assert.equal(redact(s), s);
  assert.equal(redact('ERROR 122 :: WRONG FORMAT OR EMPTY KEY'), 'ERROR 122 :: WRONG FORMAT OR EMPTY KEY');
});

test('a vendor body logged with a raw console.error is still masked', () => {
  // reportError is not the only thing that writes to Vercel's logs. Several
  // routes console.error an upstream response body directly, which is the
  // exact shape of the leak that started this: a vendor page that quoted the
  // key. Those sites pass the body through redact() too, so this pins the
  // strings they hand it.
  const openai = '{"error":{"message":"Incorrect API key provided: sk-proj-AbCdEfGhIjKlMnOp"}}';
  assert.doesNotMatch(redact(openai), /sk-proj-AbCdEfGhIjKlMnOp/);
  const opus = '{"downloadUrl":"https://cdn.opus.pro/x.mp4?token=abc123secretvalue&e=1"}';
  assert.doesNotMatch(redact(opus), /abc123secretvalue/);
  // ...while the part a person needs to read survives.
  assert.match(redact(openai), /Incorrect API key provided/);
});

test('redaction is cheap enough to sit in a logging path', () => {
  const hostile = 'a'.repeat(50_000) + '=' + 'b'.repeat(50_000);
  const t0 = Date.now();
  redact(hostile);
  redact('key=' + 'c'.repeat(100_000));
  assert.ok(Date.now() - t0 < 1000, 'redact took ' + (Date.now() - t0) + 'ms');
});
