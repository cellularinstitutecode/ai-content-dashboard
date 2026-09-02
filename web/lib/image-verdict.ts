// web/lib/image-verdict.ts
// Turn the vision reviewer's answer into a verdict — as a pure function, so it
// can be tested without an image, a key, or a network.
//
// The reviewer runs six checks. Four of them find DEFECTS: visible text,
// warped anatomy, stray logos or watermarks, graphic medical content. Those
// must flag the image and trigger a regeneration; nothing like that may reach
// a patient-facing channel. The other two are OPINIONS: "rendering quality"
// and "relevance to the topic". Those are what actually fired on the live
// deployment — "unclear relevance", "non-specific background elements" — and
// they put an amber warning on four of five perfectly usable photographs.
//
// A warning that lights up on nearly everything teaches the reviewer to stop
// reading it, including the one time it says there is text in the picture.
// So: defects are blocking, opinions are advisory, and only blocking findings
// change the status.

export type ImageVerdict = {
  status: 'approved' | 'flagged';
  score: number | null;
  /** Blocking findings — the reasons the status is 'flagged'. */
  issues: string[];
  /** Notes worth showing a person, that do not fail the image. */
  advisory: string[];
  textDetected: boolean;
};

const TEXT_RE = /\btext\b|letter|typograph|caption|\bword|writing|lettering|number|digit|signage|\bsign\b/i;

// Findings that are defects whatever the reviewer called them. Anything that
// is not one of these — composition, mood, relevance, "generic", "stock-like",
// lighting — is a matter of taste and stays advisory.
const BLOCKING_RE = new RegExp(
  [
    // anatomy
    'finger', 'hand', 'limb', 'anatom', 'warped', 'distort', 'merged', 'extra (arm|leg|eye)', 'malformed', 'deformed', 'impossible pose',
    // marks
    'logo', 'watermark', 'trademark', 'brand mark', 'brandmark',
    // graphic medical content
    'needle', 'blood', 'wound', 'gore', 'graphic', 'distressing', 'injur',
    // outright broken renders
    'uncanny', 'artifact', 'glitch', 'corrupt',
  ].join('|'),
  'i',
);

function strings(v: unknown, cap = 8): string[] {
  return Array.isArray(v) ? v.map((i) => String(i).slice(0, 160)).filter(Boolean).slice(0, cap) : [];
}

export function classifyVerdict(raw: unknown): ImageVerdict {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const score = typeof obj.score === 'number' && Number.isFinite(obj.score)
    ? Math.max(0, Math.min(100, Math.round(obj.score)))
    : null;

  // The reviewer is asked for `blocking` and `advisory` lists. An older answer
  // shape (one flat `issues` list) is sorted by content instead of trusted.
  let blocking = strings(obj.blocking);
  let advisory = strings(obj.advisory);
  if (!blocking.length && !advisory.length) {
    for (const i of strings(obj.issues)) {
      (TEXT_RE.test(i) || BLOCKING_RE.test(i) ? blocking : advisory).push(i);
    }
  }
  // A "defect" the reviewer filed under advisory is still a defect.
  const promoted = advisory.filter((i) => TEXT_RE.test(i) || BLOCKING_RE.test(i));
  if (promoted.length) {
    blocking = [...blocking, ...promoted].slice(0, 8);
    advisory = advisory.filter((i) => !promoted.includes(i));
  }

  // Text can never pass, whatever any other field says. Belt and braces: catch
  // a text mention in the findings even if the dedicated flag was forgotten.
  const textDetected = obj.textDetected === true || blocking.some((i) => TEXT_RE.test(i));
  if (textDetected && !blocking.some((i) => /\btext\b/i.test(i))) {
    blocking = ['visible text/letters detected — content images must be text-free', ...blocking].slice(0, 8);
  }

  // The reviewer saying "not approved" with no defect named at all is the one
  // ambiguous case; respect it, because the cost of a wrong pass is higher
  // than the cost of a wrong flag.
  const vetoWithoutReason = obj.approved === false && !blocking.length && !advisory.length;

  const flagged = textDetected || blocking.length > 0 || vetoWithoutReason;
  return {
    status: flagged ? 'flagged' : 'approved',
    score,
    issues: flagged && vetoWithoutReason && !blocking.length ? ['reviewer declined the image without naming a defect'] : blocking,
    advisory,
    textDetected,
  };
}
