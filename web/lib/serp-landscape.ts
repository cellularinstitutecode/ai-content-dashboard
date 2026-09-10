// web/lib/serp-landscape.ts
// Who already owns this search, and what that means for what the post should
// do about it.
//
// serpCompetitors() has been in lib/semrush.ts all along — cached, budget-
// guarded, returning the domains and URLs ranking for a phrase — and only the
// manual research screen ever called it. The video pipeline cited studies
// nobody could argue with and had no idea who it was standing next to.
//
// The reason this file is not one paragraph of advice is that the advice
// inverts. Two of this clinic's own keywords, pulled live while designing it:
//
//   "hyperbaric oxygen therapy"  -> mayoclinic.org, hopkinsmedicine.org,
//                                   pmc.ncbi.nlm.nih.gov, ucsfhealth.org,
//                                   my.clevelandclinic.org, medscape,
//                                   medlineplus.gov
//   "stem cell therapy mexico"   -> stemcellmexico.org, longevity-institute,
//                                   r3stemcell, stemcellmedicalcenter,
//                                   giostarmexico, usmexicostemcellinstitute,
//                                   immunotherapymx, regenamex, + a YouTube video
//
// The first is Mayo Clinic. A Cancún clinic will not out-explain Mayo Clinic on
// what HBOT is, and a post that tries has spent its 1,100 characters losing.
// The second is the clinic's actual competitors — and their slugs say what the
// fight is about: /best-stem-cell-clinic-in-mexico,
// /cost-of-stem-cell-treatment-in-mexico, /travel-overview/,
// /licensed-stem-cell-therapy-in-mexico.
//
// Same pipeline, same clinic, opposite instructions. So the landscape is
// classified and the posture follows from it.
//
// No imports: the test runner strips types and runs this file directly.

export type SerpRow = { domain: string; url: string };

export type SerpKind =
  /** Mayo, Hopkins, Cleveland, a university hospital — a general explainer. */
  | 'institution'
  /** NIH, PubMed, Medscape, MedlinePlus — reference literature. */
  | 'reference'
  /** Another clinic selling the same treatment. The real competitive set. */
  | 'clinic'
  /** YouTube, Instagram, TikTok — where this post is actually going. */
  | 'social'
  | 'other';

const INSTITUTION = /(mayoclinic|hopkinsmedicine|clevelandclinic|ucsfhealth|stanford|harvard|mountsinai|cedars|mskcc|unitypoint|kaiserpermanente|nhs\.uk)/i;
const REFERENCE = /(ncbi\.nlm\.nih\.gov|pubmed|medlineplus|medscape|webmd|healthline|wikipedia|cochrane|\.gov$|\.edu$)/i;
const SOCIAL = /(youtube|instagram|tiktok|facebook|reddit|linkedin|x\.com|twitter)/i;
/**
 * A peer clinic, recognised by what these businesses put in their domains.
 *
 * Deliberately last and deliberately loose: anything that is not an
 * institution, a reference or a social platform, and that talks about the
 * treatment in its own name, is competing for the same patient.
 */
const CLINIC = /(clinic|stemcell|stem-cell|regen|therapy|medical|institute|health|hbot|longevity|wellness|immuno)/i;

export function classifyDomain(domain: string): SerpKind {
  const d = String(domain || '').toLowerCase().trim();
  if (!d) return 'other';
  // Order matters: usmexicostemcellinstitute contains "institute", and
  // pmc.ncbi.nlm.nih.gov contains nothing that would mark it a clinic — but
  // hopkinsmedicine contains "medicine", so the named lists must win first.
  if (SOCIAL.test(d)) return 'social';
  if (INSTITUTION.test(d)) return 'institution';
  if (REFERENCE.test(d)) return 'reference';
  if (CLINIC.test(d)) return 'clinic';
  return 'other';
}

/**
 * What the ranking pages are competing ON, read from their URL paths.
 *
 * Free signal — the slugs are already in the response serpCompetitors returns,
 * so this costs nothing extra — and unusually honest, because a page's path is
 * chosen to match the query it wants. /cost-of-stem-cell-treatment-in-mexico
 * is a competitor telling you what its visitors are worried about.
 */
const THEMES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bbest\b|\btop-?\d*\b|\branking\b/i, 'being called the best'],
  [/\bcost|\bprice|\bpricing|\bcheap|\baffordab/i, 'what it costs'],
  [/\blicens|\bcertif|\bapprov|\baccredit|\blegal|\bregulat|\bsafe/i, 'whether it is legitimate and safe'],
  [/\btravel|\btourism|\bpackage|\bstay|\bvisit/i, 'the logistics of travelling for treatment'],
  [/\breview|\btestimonial|\bsuccess|\bresult/i, 'other patients’ results'],
  [/\bside-?effect|\brisk|\bcontraindicat/i, 'risks and side effects'],
  [/\bhow-?it-?works|\bwhat-?is|\babout|\bguide|\boverview|\bprocedure|\btreatments?\b/i, 'explaining what the treatment is'],
];

export function themesFrom(rows: readonly SerpRow[]): string[] {
  const found: string[] = [];
  for (const r of rows) {
    for (const [re, label] of THEMES) {
      if (re.test(String(r.url || '')) && !found.includes(label)) found.push(label);
    }
  }
  return found;
}

function tally(rows: readonly SerpRow[]): Record<SerpKind, number> {
  const out: Record<SerpKind, number> = { institution: 0, reference: 0, clinic: 0, social: 0, other: 0 };
  for (const r of rows) out[classifyDomain(r.domain)]++;
  return out;
}

/**
 * The competitive block appended to the writer's brief.
 *
 * Returns '' when there is no SERP data, and the post is written exactly as it
 * would have been — the same fail-open rule as the keyword brief and the
 * research brief.
 */
export function serpLandscapeFrom(phrase: string, rows: readonly SerpRow[]): string {
  const usable = rows.filter((r) => r && r.domain).slice(0, 10);
  if (!usable.length || !String(phrase || '').trim()) return '';

  const counts = tally(usable);
  const themes = themesFrom(usable);
  const names = [...new Set(usable.map((r) => r.domain.replace(/^www\./, '')))].slice(0, 6);
  // The question is whether BIG PUBLISHERS own this search, not whether every
  // competitor can be named. "giostarmexico.com" is a rival clinic with nothing
  // in its domain to say so, and classifying it 'other' is correct — but
  // counting it as neutral would have let two recognisable institutions
  // outvote eight competitors and hand the post the wrong instruction
  // entirely. Anything that is not an institution or a reference work is a
  // commercial page competing for the same patient.
  const authority = counts.institution + counts.reference;
  const peerLed = authority < usable.length / 2;

  const lines: string[] = [];
  lines.push('SEARCH LANDSCAPE (live SERP for "' + phrase + '" — who the reader is comparing this clinic against):');
  lines.push('- Currently ranking: ' + names.join(', ') + '.');
  if (themes.length) lines.push('- What those pages compete on: ' + themes.join('; ') + '.');

  if (peerLed) {
    // The competitors ARE other clinics. Everyone is making the same promise.
    lines.push(
      '- These are rival clinics selling the same treatment, and they all promise the same things. ' +
      'The reader has already read those promises. Do not repeat them and do not out-claim them: answer the ' +
      'same underlying worry with something VERIFIABLE from this video — the equipment named, the step ' +
      'actually performed, the measurement stated, the check done before treatment. A specific a competitor ' +
      'cannot copy is the only durable advantage here.',
    );
  } else {
    // The competitors are Mayo, Hopkins, the NIH. Different game entirely.
    lines.push(
      '- These are large medical publishers and reference sites writing general explainers. This post will not ' +
      'out-explain them and must not try — a caption spent defining the treatment is a caption spent losing. ' +
      'Their structural limit is that they can never show one clinic actually doing the thing. That is exactly ' +
      'what this video has, so lead with it: what happens here, in what order, with what equipment, checked how.',
    );
  }

  // Comparative advertising is separately regulated, and a medical advertiser
  // naming a rival is a problem this pipeline should never be able to create.
  lines.push('- NEVER name a competitor, quote one, or make a comparative claim ("better than", "unlike other clinics"). This is context for what to emphasise, not material to write about.');
  return lines.join('\n');
}
