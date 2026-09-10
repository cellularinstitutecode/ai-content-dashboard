// web/lib/evidence-brief.ts
// Real papers, as material the writer can actually use.
//
// Until now the citation was decoration. The model recalled a study from
// memory, lib/citation.ts asked Crossref whether that DOI exists, and the
// paper's CONTENTS were never fetched by anything — so the post could not
// possibly draw on it. Row 184 cited Caplan & Correa's "The MSC: an injury
// drugstore", a genuinely landmark review, and said nothing that came from it.
//
// Now the search happens first and the abstracts are handed over as source
// material, which changes three things at once: the copy can say something
// substantive, the DOI is real by construction rather than by luck, and the
// invent-a-citation -> Crossref-rejects -> regenerate cycle stops costing a
// second model call.
//
// It also raises the stakes. A clinic advertising under COFEPRIS that misreads
// a paper is worse off than one that cited it decoratively, so the three rules
// below are not stylistic — they are the conditions under which quoting
// research is safe, and they are stated to the model as prohibitions rather
// than preferences.
//
// No imports: the test runner strips types and runs this file directly.

// One declaration, in lib/evidence-parse.ts, so the parsers and the brief
// cannot drift into disagreeing about what a paper is.
export type { EvidenceItem } from './evidence-parse.ts';
import type { EvidenceItem } from './evidence-parse.ts';

/**
 * How much of each abstract to hand over.
 *
 * Enough to carry the finding and its hedging — an abstract cut before its
 * limitations reads more certain than the paper is, which is the exact failure
 * the third rule below forbids.
 */
export const MAX_ABSTRACT_CHARS = 1200;
/** More than three is a reading list, not a brief. */
export const MAX_ITEMS = 3;

function trimAbstract(text: string): string {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= MAX_ABSTRACT_CHARS) return clean;
  // Cut at a sentence end so the last thing the model reads is a complete
  // claim rather than half of one it might complete for itself.
  const head = clean.slice(0, MAX_ABSTRACT_CHARS);
  const stop = head.lastIndexOf('. ');
  return (stop > MAX_ABSTRACT_CHARS / 2 ? head.slice(0, stop + 1) : head) + ' […]';
}

function cite(item: EvidenceItem): string {
  const bits = [item.firstAuthor || 'Author', item.year ? '(' + item.year + ')' : '', '"' + item.title + '."', item.journal]
    .filter(Boolean);
  return bits.join(' ') + ' DOI: ' + item.doi;
}

/**
 * The research block appended to the writer's brief.
 *
 * Returns '' when nothing was found, and the caller then writes exactly as it
 * did before — no research is a quieter post, never a failed one.
 */
export function evidenceBriefFrom(items: readonly EvidenceItem[]): string {
  const usable = items.filter((i) => i && i.doi && i.title && String(i.abstract || '').trim()).slice(0, MAX_ITEMS);
  if (!usable.length) return '';

  const lines: string[] = [];
  lines.push('PUBLISHED RESEARCH (retrieved for this video — real papers, real DOIs, abstracts as published):');
  usable.forEach((item, i) => {
    lines.push('');
    lines.push('[' + (i + 1) + '] ' + cite(item));
    lines.push('ABSTRACT: ' + trimAbstract(item.abstract));
  });
  lines.push('');
  lines.push(
    '- Use ONE of these. Pick whichever genuinely relates to what the speaker is describing, make ONE concrete, ' +
    'accurate point from its abstract somewhere in the body, and put THAT paper in the REF line, copying its DOI ' +
    'exactly as given above. Do not cite a study from memory: these are the ones that were checked.',
  );
  lines.push(
    '- If none of them actually relates to this video, ignore them entirely and cite a study you are confident ' +
    'exists, as before. A forced connection is worse than a general one.',
  );
  // The three prohibitions. Stated as things the copy must never do, because a
  // clinic advertising under COFEPRIS cannot walk one of them back later.
  lines.push('- NEVER imply the study was conducted at this clinic, or that it reports this clinic’s own results. It is outside evidence about the field, not evidence about us.');
  lines.push('- NEVER turn a mechanism into a promise. A paper showing HOW something works is not a claim that it WILL work for the reader. No outcome is being guaranteed to anyone.');
  lines.push('- NEVER state anything the abstract above does not support. Do not extrapolate, do not round a hedged finding into a firm one, and if the abstract says a result is partial or uncertain, keep it partial or uncertain.');
  return lines.join('\n');
}
