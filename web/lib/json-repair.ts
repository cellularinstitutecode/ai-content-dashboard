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
      if (ch === '"') {
        // A quote inside a string that is not the string's end: the next
        // non-blank character after a real end is always structural (a
        // comma, a colon, a closing brace or bracket, or nothing). Anything
        // else — a letter, a space then a word — is a study title or a quote
        // in the copy that the writer did not escape. Escape it and go on;
        // the REF line's "Safety and feasibility of …" was sinking whole
        // posts this way.
        let j = i + 1;
        while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++;
        const next = text[j];
        const ends = next === undefined || next === ',' || next === '}' || next === ']' || next === ':' || next === '\n' || next === '\r';
        if (!ends) { out += '\\"'; continue; }
        out += ch; inString = false; continue;
      }
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

/**
 * The last resort: the four channel fields read by their KEYS, for an
 * answer that is a JSON object in shape but not in letter — an unescaped
 * quote the repair above could not place, a stray brace inside the copy.
 * The keys are fixed and in a known order, so each value is the text
 * between its opening quote and the quote before the next key (or the
 * closing brace). Null when even that is not there.
 */
export function extractPackFields(text: string): Record<string, string> | null {
  const t = String(text || '');
  const keys = ['instagram', 'facebook', 'linkedin', 'blog'];
  const at = keys.map((k) => {
    const m = new RegExp('"' + k + '"\\s*:\\s*"').exec(t);
    return m ? { key: k, start: m.index, valueStart: m.index + m[0].length } : null;
  }).filter((x): x is { key: string; start: number; valueStart: number } => Boolean(x)).sort((a, b) => a.start - b.start);
  if (!at.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < at.length; i++) {
    const end = i + 1 < at.length ? at[i + 1].start : t.lastIndexOf('}');
    if (end <= at[i].valueStart) continue;
    let raw = t.slice(at[i].valueStart, end);
    // Back to the value's closing quote: whatever follows it (a comma, blanks) is not copy.
    const close = raw.lastIndexOf('"');
    if (close >= 0) raw = raw.slice(0, close);
    out[at[i].key] = raw
      .replace(/\\n/g, '\n').replace(/\\r/g, '').replace(/\\t/g, '\t')
      .replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return Object.keys(out).length ? out : null;
}
