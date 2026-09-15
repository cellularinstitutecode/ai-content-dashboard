// web/lib/json-repair.ts
// The two ways a model's JSON is usually "malformed", and how to read it anyway.
//
// The writer is asked for one JSON object with paragraph breaks escaped as
// \n. Now and then it emits a real line break inside a string instead, or
// leaves a comma before the closing brace — and JSON.parse refuses the whole
// answer for it. The copy is all there. Throwing it away and asking again,
// at full price, for the same slip is what "incomplete or garbled, twice
// running" was made of.
//
// Pure, no imports: run directly by the test runner.

/**
 * Escape raw control characters inside string literals and drop trailing
 * commas. Text outside strings is left alone; a string that is already
 * escaped correctly is returned byte for byte.
 */
export function repairJsonText(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) { out += ch; escaped = false; continue; }
      if (ch === '\\') { out += ch; escaped = true; continue; }
      if (ch === '"') { out += ch; inString = false; continue; }
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        out += ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : ch === '\t' ? '\\t' : '\\u' + code.toString(16).padStart(4, '0');
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') { out += ch; inString = true; continue; }
    if (ch === ',') {
      // A comma whose next non-blank character closes the object or array is
      // a trailing comma: skip it.
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') continue;
    }
    out += ch;
  }
  return out;
}

/**
 * What to say about text that could not be parsed even after repair — short
 * enough for one register line, specific enough to tell "cut off" from
 * "never JSON".
 */
export function jsonDiagnostic(text: string): string {
  const t = String(text || '');
  const n = t.length;
  if (!n) return 'empty answer';
  const trimmed = t.trim();
  const tail = trimmed.slice(-20).replace(/\s+/g, ' ');
  if (!trimmed.startsWith('{')) return n + ' chars, not a JSON object';
  if (!trimmed.endsWith('}')) return n + ' chars, cut off before the closing brace: …' + tail;
  return n + ' chars, ends …' + tail;
}
