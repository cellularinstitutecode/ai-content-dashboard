import test from 'node:test';
import assert from 'node:assert/strict';
import { jsonDiagnostic, repairJsonText, extractPackFields } from './json-repair.ts';

test('a raw line break inside a string is escaped, and the object parses', () => {
  const raw = '{"instagram":"First line.\nSecond line.\tTabbed","linkedin":"ok"}';
  assert.throws(() => JSON.parse(raw));
  const fixed = JSON.parse(repairJsonText(raw));
  assert.equal(fixed.instagram, 'First line.\nSecond line.\tTabbed');
  assert.equal(fixed.linkedin, 'ok');
});

test('text that is already valid comes back byte for byte', () => {
  const ok = '{"a":"one\\ntwo","b":"quote \\" inside","c":[1,2,{"d":"x"}]}';
  assert.equal(repairJsonText(ok), ok);
  JSON.parse(repairJsonText(ok));
});

test('a trailing comma before } or ] is dropped; commas inside strings are kept', () => {
  const raw = '{"a":"x, y,","b":[1,2,],}';
  assert.equal(repairJsonText(raw), '{"a":"x, y,","b":[1,2]}');
  assert.deepEqual(JSON.parse(repairJsonText(raw)), { a: 'x, y,', b: [1, 2] });
});

test('an escaped backslash before a quote does not end the string early', () => {
  const raw = '{"a":"ends with backslash\\\\","b":"line\nbreak"}';
  const fixed = JSON.parse(repairJsonText(raw));
  assert.equal(fixed.a, 'ends with backslash\\');
  assert.equal(fixed.b, 'line\nbreak');
});

test('other control characters become \\u escapes', () => {
  const raw = '{"a":"xy"}';
  assert.equal(repairJsonText(raw), '{"a":"x\\u0001y"}');
});

test('the diagnostic tells cut off from never JSON from empty', () => {
  assert.equal(jsonDiagnostic(''), 'empty answer');
  assert.match(jsonDiagnostic('Sure! Here is the copy you asked for.'), /not a JSON object/);
  assert.match(jsonDiagnostic('{"instagram":"half a post'), /cut off before the closing brace/);
  assert.match(jsonDiagnostic('{"instagram":"done"}'), /^20 chars, ends/);
});

test('a study title in straight quotes that the writer did not escape no longer ends the string early', () => {
  // The REF line that sank whole posts: …(2020). "Safety and feasibility of …" Cytotherapy…
  const raw = '{"instagram": "Ask your provider. REF: Levy, O. (2020). "Safety and feasibility of MSCs." Cytotherapy, 22(5). DOI: 10.1016/j.jcyt.2020.03.215", "facebook": "ok", "linkedin": "ok", "blog": ""}';
  const obj = JSON.parse(repairJsonText(raw));
  assert.match(obj.instagram, /"Safety and feasibility of MSCs\." Cytotherapy/);
  assert.equal(obj.facebook, 'ok');
  // A real closing quote followed by a comma, brace or colon is still a closing quote.
  assert.deepEqual(JSON.parse(repairJsonText('{"a": "x", "b": "y"}')), { a: 'x', b: 'y' });
});

test('the last resort reads the four fields by their keys when nothing else parses', () => {
  const raw = '{"instagram": "Line one\\nREF: X. "Title" Y. DOI: 1", "facebook": "f "quoted" f", "linkedin": "l", "blog": "b }"}';
  const got = extractPackFields(raw);
  assert.ok(got);
  assert.equal(got!.instagram, 'Line one\nREF: X. "Title" Y. DOI: 1');
  assert.equal(got!.facebook, 'f "quoted" f');
  assert.equal(got!.linkedin, 'l');
  assert.equal(got!.blog, 'b }');
  assert.equal(extractPackFields('no json here'), null);
});
