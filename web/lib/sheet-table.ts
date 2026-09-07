// web/lib/sheet-table.ts
// Turning a human-edited Google Sheet into records, without depending on the
// exact layout: the header row is found by content, columns are matched by
// name (in English or Spanish), and dates are read in the forms people type.
// Pure, so it is unit-tested; lib/google-sources.ts does the fetching.

/** A1 column letter for a zero-based index: 0 → A, 25 → Z, 26 → AA. */
export function columnLetter(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export type SheetRecord = {
  /** The row's cells, keyed by normalised header. */
  rec: Record<string, string>;
  /** 1-based row number in the tab, so the row can be written back. */
  row: number;
};

export type SheetTable = {
  header: string[];
  /** 1-based row number of the header itself. */
  headerRow: number;
  records: SheetRecord[];
};

/**
 * Find the header row (the first row with ≥ 3 of the wanted names) and map rows
 * to objects keyed by normalised header.
 *
 * Each record carries its 1-based ROW NUMBER. Without it a value read out of a
 * sheet can never be written back: an update needs "'September 2026'!M7", and
 * the row is the half that cannot be recovered afterwards.
 */
export function tableFromRows(rows: string[][], wanted: string[]): SheetTable {
  const norm = (s: string) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const wantedNorm = wanted.map(norm);
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const cells = (rows[i] || []).map(norm);
    const hits = cells.filter((c) => c && wantedNorm.some((w) => c === w || c.startsWith(w))).length;
    if (hits >= 3) { headerIdx = i; break; }
  }
  if (headerIdx < 0) return { header: [], headerRow: 0, records: [] };
  // An unnamed column keeps its place under a positional key, so a sheet
  // whose first column is a name with no header (Rodrigo's) is not lost.
  const header = (rows[headerIdx] || []).map((h, i) => norm(h) || 'col' + i);
  const records: SheetRecord[] = [];
  rows.slice(headerIdx + 1).forEach((row, offset) => {
    if (!row || row.every((c) => !String(c || '').trim())) return;
    const rec: Record<string, string> = {};
    header.forEach((h, i) => { rec[h] = String(row[i] ?? '').trim(); });
    // +1 for the header itself, +1 again because sheets count from 1.
    records.push({ rec, row: headerIdx + offset + 2 });
  });
  return { header, headerRow: headerIdx + 1, records };
}

/**
 * The A1 column letter a named field lives in, or null when the sheet has no
 * such column. Matches the same way pick() does, so what you can read you can
 * address.
 */
export function columnFor(header: string[], ...names: string[]): string | null {
  for (const n of names) {
    const i = header.findIndex((h) => h === n || h.startsWith(n));
    if (i >= 0) return columnLetter(i);
  }
  return null;
}

export function pick(rec: Record<string, string>, ...names: string[]): string {
  for (const n of names) {
    const key = Object.keys(rec).find((k) => k === n || k.startsWith(n));
    if (key && rec[key]) return rec[key];
  }
  return '';
}

/** "May 13, 2026" / "13/05/2026" / ISO → ISO date (YYYY-MM-DD) or null. */
export function parseSheetDate(raw: string): string | null {
  const s = String(raw || '').trim();
  if (!s) return null;
  // A bare number ("13") is a calendar-grid cell, not a date; Date.parse would
  // happily read it as a year.
  if (!/\d{4}/.test(s) && !/[a-z]{3}/i.test(s)) return null;
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (dmy) {
    const d = new Date(Date.UTC(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1])));
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  const t = Date.parse(s.replace(/(\d)(st|nd|rd|th)\b/g, '$1'));
  if (isNaN(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

