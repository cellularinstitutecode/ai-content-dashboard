// web/lib/sheet-table.ts
// Turning a human-edited Google Sheet into records, without depending on the
// exact layout: the header row is found by content, columns are matched by
// name (in English or Spanish), and dates are read in the forms people type.
// Pure, so it is unit-tested; lib/google-sources.ts does the fetching.

/** Find the header row (the first row with ≥ 3 of the wanted names) and map rows to objects keyed by normalised header. */
export function tableFromRows(rows: string[][], wanted: string[]): { header: string[]; records: Record<string, string>[] } {
  const norm = (s: string) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const wantedNorm = wanted.map(norm);
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const cells = (rows[i] || []).map(norm);
    const hits = cells.filter((c) => c && wantedNorm.some((w) => c === w || c.startsWith(w))).length;
    if (hits >= 3) { headerIdx = i; break; }
  }
  if (headerIdx < 0) return { header: [], records: [] };
  // An unnamed column keeps its place under a positional key, so a sheet
  // whose first column is a name with no header (Rodrigo's) is not lost.
  const header = (rows[headerIdx] || []).map((h, i) => norm(h) || 'col' + i);
  const records: Record<string, string>[] = [];
  for (const row of rows.slice(headerIdx + 1)) {
    if (!row || row.every((c) => !String(c || '').trim())) continue;
    const rec: Record<string, string> = {};
    header.forEach((h, i) => { rec[h] = String(row[i] ?? '').trim(); });
    records.push(rec);
  }
  return { header, records };
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

