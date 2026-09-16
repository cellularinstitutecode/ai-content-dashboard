import test from 'node:test';
import assert from 'node:assert/strict';
import { metricoolRefusal } from './metricool-refusal.ts';

test('a disconnected network sends you to the connection, not the post', () => {
  const m = metricoolRefusal(400, '{"error":"No linkedin profile connected for this brand"}', 'linkedin');
  assert.match(m, /^LinkedIn is not connected/);
  assert.match(m, /Connections/);
  assert.match(m, /nothing about the post needs changing/);
});

test('an expired or rejected token is the same problem, and 401⁄403 alone is enough', () => {
  for (const [status, body] of [[400, '{"message":"token expired"}'], [401, '{}'], [403, 'Forbidden']] as [number, string][]) {
    assert.match(metricoolRefusal(status, body, 'linkedin'), /is not connected to this brand/, status + ' ' + body);
  }
});

test('a media rejection says the file, not the copy', () => {
  const m = metricoolRefusal(400, '{"error":"video duration exceeds the maximum for this network"}', 'linkedin');
  assert.match(m, /would not accept the video for LinkedIn/);
  assert.match(m, /the copy is fine, the file is not/);
});

test('a length rejection names the network’s own limit', () => {
  assert.match(metricoolRefusal(400, '{"error":"text length exceeds maximum"}', 'linkedin'), /too long for LinkedIn, which allows 3,000 characters/);
  assert.match(metricoolRefusal(400, '{"error":"caption too long"}', 'tiktok'), /2,200 characters/);
  // A network with no limit on file still gets a usable sentence.
  assert.match(metricoolRefusal(400, '{"error":"description exceeds max length"}', 'threads'), /^The text is too long for Threads\. /);
});

test('a bad publishing time, a rate limit and an outage each read differently', () => {
  assert.match(metricoolRefusal(400, '{"error":"publicationDate is in the past"}', 'linkedin'), /refused the publishing time/);
  assert.match(metricoolRefusal(429, '{}', 'linkedin'), /rate-limiting this account/);
  assert.match(metricoolRefusal(503, '{}', 'linkedin'), /problem of its own \(HTTP 503\)/);
});

test('the fallback names the status, so two failures never read identically', () => {
  const a = metricoolRefusal(400, '{"weird":"unrecognised"}', 'linkedin');
  const b = metricoolRefusal(422, '{"weird":"unrecognised"}', 'linkedin');
  assert.notEqual(a, b);
  assert.match(a, /HTTP 400/);
  assert.match(b, /HTTP 422/);
  assert.match(metricoolRefusal(NaN, '', 'linkedin'), /HTTP no status/);
});

test('an unknown or missing network still produces a sentence', () => {
  assert.match(metricoolRefusal(400, '{}', ''), /that network/);
  assert.match(metricoolRefusal(400, '{}', 'bluesky'), /Bluesky/);
});

test('NOTHING from the provider’s body can reach the person', () => {
  // THE HOUSE RULE (lib/friendly-error.ts): an upstream provider's raw error
  // body is never shown. This is the assertion that keeps it true as patterns
  // are added — a secret, an internal host or a customer id pasted into
  // Metricool's error text must not come back out of this function.
  const secrets = [
    'sk-live-abcdef123456', 'https://internal.metricool.local/x', 'blogId=4308292',
    'Bearer eyJhbGciOiJIUzI1NiJ9', 'user@example.com',
  ];
  for (const secret of secrets) {
    for (const status of [400, 401, 403, 422, 429, 500]) {
      for (const shape of ['{"error":"' + secret + '"}', secret, '{"message":"video failed: ' + secret + '"}']) {
        const out = metricoolRefusal(status, shape, 'linkedin');
        assert.ok(!out.includes(secret), 'leaked ' + secret + ' at ' + status);
      }
    }
  }
});
