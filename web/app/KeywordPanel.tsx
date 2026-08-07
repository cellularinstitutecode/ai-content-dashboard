'use client';
// web/app/KeywordPanel.tsx
// Keyword Intelligence panel — surfaces Mangools KWFinder data in the dashboard
// so both you and the AI share the same keyword picture. Type a topic and hit
// Analyze to pull search volume + difficulty. This is the same data the AI uses
// automatically during draft generation (see /api/generate).
import { useState } from 'react';

type KeywordMetric = {
  keyword: string;
  volume: number | null;
  difficulty: number | null;
  cpc: number | null;
};

function kwfinderUrl(keyword: string): string {
  const kw = (keyword || '').trim();
  const base = 'https://app.mangools.com/kwfinder/keywords';
  return kw ? base + '?kw=' + encodeURIComponent(kw) : base;
}

function difficultyTone(d: number | null): string {
  if (d == null) return 'text-ink-faint';
  if (d < 30) return 'text-emerald-600';
  if (d < 50) return 'text-amber-600';
  return 'text-rose-600';
}

export default function KeywordPanel({ initialTopic = '' }: { initialTopic?: string }) {
  const [topic, setTopic] = useState(initialTopic);
  const [rows, setRows] = useState<KeywordMetric[]>([]);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [ran, setRan] = useState(false);

  async function analyze() {
    const seed = topic.trim();
    if (!seed) return;
    setLoading(true);
    setNote(null);
    try {
      const r = await fetch('/api/keywords?topic=' + encodeURIComponent(seed));
      const j = await r.json().catch(() => null);
      setRan(true);
      if (j && j.ok && Array.isArray(j.keywords) && j.keywords.length) {
        setRows(j.keywords);
        setNote(null);
      } else {
        setRows([]);
        setNote((j && j.note) || 'No keyword data available.');
      }
    } catch {
      setRows([]);
      setNote('Could not reach the keyword service.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="overflow-hidden rounded-3xl bg-white ring-1 ring-line shadow-soft">
      <div className="flex items-center justify-between gap-3 border-b border-line px-6 py-4">
        <div className="flex items-center gap-3">
          <span aria-hidden className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700">🔑</span>
          <div>
            <h3 className="text-[15px] font-semibold text-ink">Keyword Intelligence</h3>
            <p className="text-[12px] text-ink-muted">Mangools KWFinder data. The AI uses these keywords automatically on every draft.</p>
          </div>
        </div>
        <a href={kwfinderUrl(topic)} target="_blank" rel="noopener noreferrer" className="shrink-0 text-[12px] font-medium text-emerald-700 hover:text-emerald-800">Open in KWFinder ↗</a>
      </div>
      <div className="p-6">
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            type="text"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') analyze(); }}
            placeholder="e.g. stem cell therapy for knee pain"
            className="flex-1 rounded-xl bg-subtle px-3.5 py-2.5 text-[14px] text-ink ring-1 ring-line focus:outline-none focus:ring-2 focus:ring-emerald-300"
          />
          <button
            type="button"
            onClick={analyze}
            disabled={loading || !topic.trim()}
            className="shrink-0 rounded-xl bg-emerald-600 px-4 py-2.5 text-[14px] font-medium text-white transition hover:bg-emerald-700 disabled:opacity-50"
          >
            {loading ? 'Analyzing…' : 'Analyze'}
          </button>
        </div>

        {rows.length > 0 && (
          <div className="mt-4 overflow-hidden rounded-2xl ring-1 ring-line">
            <table className="w-full text-left text-[13px]">
              <thead className="bg-subtle text-ink-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Keyword</th>
                  <th className="px-3 py-2 font-medium text-right">Volume</th>
                  <th className="px-3 py-2 font-medium text-right">Difficulty</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((k, i) => (
                  <tr key={k.keyword + i} className="border-t border-line">
                    <td className="px-3 py-2 text-ink">
                      <a href={kwfinderUrl(k.keyword)} target="_blank" rel="noopener noreferrer" className="hover:text-emerald-700">{k.keyword}</a>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink-muted">{k.volume != null ? k.volume.toLocaleString() : '—'}</td>
                    <td className={'px-3 py-2 text-right tabular-nums font-medium ' + difficultyTone(k.difficulty)}>{k.difficulty != null ? k.difficulty : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {ran && note && (
          <p className="mt-3 text-[12px] text-ink-muted">{note} You can still open KWFinder above for full research.</p>
        )}
      </div>
    </section>
  );
}
