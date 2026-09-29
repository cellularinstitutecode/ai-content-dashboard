// web/lib/citation-gate.ts
// Three checks the September audit said were missing, in words a person and a
// test can both read.
//
// THE AUDIT (auditoría de rendimiento, Sept 2026, point 3): "Los textos
// escritos por IA en el planificador citan estudios que no tienen relación:
// un ensayo de tadalafil en una publicación sobre péptidos, un artículo sobre
// el virus vaccinia en una publicación sobre columna, y un estudio sobre
// videos de unboxing para niños. Un borrador es solo la IA diciendo que la
// transcripción no tenía contenido."
//
// HOW EACH ONE GOT THROUGH. The app already has a judge that reads the cited
// paper's abstract and says whether it backs the post (lib/claim-support.ts),
// and it already ran. Its "no" was stamped on the draft, shown on the card as
// a note, and read by exactly one thing: the switch that decides whether the
// engine may approve its own work. A PERSON pressing Approve, Send or Publish
// went through doors that checked the REF line existed and its DOI resolved
// — and never asked what the judge had said. The video path was worse: when
// the judge said no paper backed the copy, it cited the top search hit anyway
// and published it "flagged". And a transcript with no speech in it reached
// the writer, which wrote a paragraph about the transcript having no speech
// in it, which passed every check because it had a REF line.
//
// This file holds the decisions. The doors (lib/compliance-gate.ts, Autopilot
// approve, lib/video-prepare.ts, lib/video-transcript.ts) call them.
//
// No imports, deliberately: the test runner strips types and runs this file.

/**
 * The judge's verdict on the draft, or null when the draft carries none.
 *
 * Two spellings, because two pipelines write it: the Autopilot stamps
 * `_claimSupport` and the video pipeline (lib/video-prepare.ts) stamps
 * `claimSupport`. Reading only one of them is how a video post's 'unsupported'
 * never reached the gate that was written to read it.
 */
export function claimSupportOf(pack: unknown): string | null {
  if (!pack || typeof pack !== 'object') return null;
  const p = pack as { _claimSupport?: { status?: unknown } | null; claimSupport?: { status?: unknown } | null };
  for (const stamp of [p._claimSupport, p.claimSupport]) {
    const status = stamp && typeof stamp === 'object' ? String(stamp.status || '').trim().toLowerCase() : '';
    if (status) return status;
  }
  return null;
}

/**
 * The one sentence that refuses a post whose citation the judge rejected.
 *
 * Only 'unsupported' refuses: the judge read the paper and said no.
 * 'unchecked' does not — the judge not running is not evidence of a problem,
 * and the DOI has already been verified — and neither does a missing stamp,
 * because most hand-written posts never had one. The doors that can afford
 * it judge an unchecked citation on the spot (Autopilot's approve).
 */
export function claimSupportRefusal(status: string | null | undefined): string | null {
  if (String(status || '').trim().toLowerCase() !== 'unsupported') return null;
  return 'Not sent: the study cited in the REF line does not support what this post says. ' +
    'A reference under a claim it does not back is the thing a reader can check and the clinic cannot defend. ' +
    'Replace the citation with a study that shows the point the post makes (press FIX on the card, or edit the REF line), then send again. Nothing was sent.';
}

// --- the writer describing an empty transcript instead of the video ---------

/**
 * Is this "copy" the writer explaining that it had nothing to work with?
 *
 * The draft the audit found read, in effect, "the transcript contained no
 * content". It carried a REF line and an AVISO, so every gate passed it. A
 * caption written for a clinic never mentions the transcript at all — the
 * word is the giveaway, and it is looked for beside the words that say
 * "empty". A few other shapes a refusing model uses are listed with it.
 */
export function writerRefusedContent(text: string | null | undefined): boolean {
  const t = String(text || '');
  if (!t.trim()) return false;
  // "transcript" / "transcription" in the same sentence as "no", "not",
  // "empty", "nothing", "unable", "missing"…
  const sentences = t.split(/(?<=[.!?])\s+|\n+/);
  const empty = /\b(no|not|without|lacks?|lacking|empty|blank|nothing|unable|cannot|can't|could\s*not|couldn't|does\s*not|doesn't|did\s*not|didn't|missing|unavailable|absent|insufficient)\b/i;
  for (const s of sentences) {
    if (/\btranscript(ion|s)?\b/i.test(s) && empty.test(s)) return true;
  }
  const meta = [
    /\bas an ai\b/i,
    /\bi(?:'m| am) (?:sorry|unable|afraid)\b/i,
    /\bi (?:cannot|can't|am unable to) (?:write|create|generate|produce|provide|help)\b/i,
    /\bthe (?:video|recording|audio|clip|file) (?:does not|doesn't|did not|didn't) (?:contain|include|have|provide) (?:any )?(?:speech|spoken|content|words|dialogue|narration|audio|information)/i,
    /\bno (?:audio|speech|spoken|verbal|dialogue) (?:content|words|track|was (?:found|detected|provided))/i,
    /\bplease (?:provide|share|paste) (?:a|the|an) (?:transcript|text|script|content)/i,
    /\b(?:provided|given|supplied) (?:text|content|transcript|input) (?:is|was|appears) (?:empty|blank|missing|too short)/i,
  ];
  return meta.some((re) => re.test(t));
}

// --- a transcript that is actually speech -------------------------------------

/**
 * Does this transcript hold enough speech to write from?
 *
 * The old rule was forty characters. "[Music] [Music] Thank you. [Applause]"
 * is longer than that and says nothing, and a model asked to write a clinic
 * post from it writes about having nothing to write from. Bracketed sound
 * tags are stripped, and what remains has to contain at least a dozen
 * DIFFERENT words of three letters or more: a real sentence or two, and
 * nothing a caption tool's hallucinated "thank you" on loop can reach.
 */
export const MIN_DISTINCT_WORDS = 12;

export function looksLikeSpeech(text: string | null | undefined): boolean {
  const cleaned = String(text || '')
    .replace(/\[[^\]]{0,40}\]/g, ' ')
    .replace(/\([^)]{0,40}\)/g, ' ')
    .replace(/[♪♫]+/g, ' ');
  const words = cleaned.toLowerCase().match(/[a-záéíóúñüàèìòùâêîôûäëïöüç]{3,}/gi) || [];
  const distinct = new Set(words);
  return distinct.size >= MIN_DISTINCT_WORDS;
}
