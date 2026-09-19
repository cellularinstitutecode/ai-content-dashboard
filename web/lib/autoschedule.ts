// web/lib/autoschedule.ts
// May the engine send this post without a person looking at it?
//
// Everything this file reads was already being computed and already being
// ignored. The score was advisory. The Crossref verdict was stamped on the
// pack and never consulted at the door. The claim-support judge was never
// imported by the engine at all. A picture was best-effort. None of that
// mattered while a human pressed Approve on every post, because the human was
// the floor. Take the human out and there is no floor — so this is it.
//
// FAIL CLOSED, WHICH IS THE OPPOSITE OF EVERY OTHER GUARD HERE. The rest of
// this codebase fails open on purpose: a citation check that cannot reach
// Crossref must not stop a video going out, because the cost of a missing
// badge is smaller than the cost of a stalled pipeline. Here the costs are the
// other way round. The cost of waiting is somebody pressing a button; the cost
// of guessing is a published medical advertisement citing a paper nobody
// confirmed exists. So anything unknown, unreachable or unrecognised waits.
//
// WHAT IT DOES NOT DO. It does not replace the compliance gate, the video
// rule, or lib/post-preflight.ts — those still run inside approveRun and can
// still refuse a post a person approved by hand. This only decides whether the
// engine may press the button ITSELF.
//
// Pure: `./x.ts` imports only, so the test runner reads this file directly.
import { NETWORKS_NEEDING_MEDIA } from './composer.ts';

/** What lib/citation.ts concluded about the DOI in the REF line. */
export type CitationStatus = 'verified' | 'not_found' | 'unavailable' | 'no_doi' | string;

/** What lib/claim-support.ts concluded about whether that paper backs the copy. */
export type ClaimSupportStatus = 'supported' | 'swapped' | 'unsupported' | 'unchecked' | string;

export type AutoScheduleInput = {
  /** `pack._compliance.citation.status`, stamped at generation time. */
  citation?: CitationStatus | null;
  /** `scorePack(...).total`, 0-100. */
  score?: number | null;
  /** SCORE_THRESHOLD, passed in so the constant stays in planner-constants.ts. */
  threshold: number;
  /** How many safety flags the rubric raised. */
  safetyFlags?: number | null;
  /** The networks this post is going to. */
  networks?: readonly string[] | null;
  /** Does it actually carry a picture or a video? */
  hasMedia?: boolean;
  /** `claimSupport.status`, when the judge ran. */
  claimSupport?: ClaimSupportStatus | null;
};

export type AutoScheduleVerdict =
  | { ok: true }
  | {
      ok: false;
      reason: 'citation' | 'score' | 'safety' | 'media' | 'claim' | 'networks';
      message: string;
    };

/** The reasons, in the order a person would want them: worst first. */
export function autoScheduleVerdict(input: AutoScheduleInput): AutoScheduleVerdict {
  const networks = (input.networks || []).map((n) => String(n || '').trim().toLowerCase()).filter(Boolean);
  if (!networks.length) {
    return {
      ok: false,
      reason: 'networks',
      message: 'This template has no channels selected, so there is nowhere to send it.',
    };
  }

  // 1. The citation. `checkCompliance` only proves a DOI is SHAPED like a DOI;
  //    this is the one signal that says a real paper answered to it. An
  //    unreachable Crossref reads as "not known", never as "fine".
  if (input.citation !== 'verified') {
    const said =
      input.citation === 'not_found'
        ? 'Crossref has no record of the DOI in the REF line'
        : input.citation === 'no_doi'
          ? 'the REF line carries no DOI'
          : input.citation === 'unavailable'
            ? 'the citation could not be checked against Crossref just now'
            : 'the citation was never checked';
    return {
      ok: false,
      reason: 'citation',
      message: 'Held for you because ' + said + '. A cited study is the one claim in this post that nobody can verify after it publishes.',
    };
  }

  // 2. The paper has to back what the post says. 'unchecked' passes: the judge
  //    not running is not evidence of a problem, and the citation above is
  //    already verified. 'unsupported' is the judge actively saying no.
  if (input.claimSupport === 'unsupported') {
    return {
      ok: false,
      reason: 'claim',
      message: 'Held for you because the cited study does not clearly support what this post says. Worth a read before it goes out.',
    };
  }

  // 3. The rubric's own number, which until now nothing ever refused a run for.
  const score = typeof input.score === 'number' && Number.isFinite(input.score) ? input.score : null;
  if (score == null) {
    return {
      ok: false,
      reason: 'score',
      message: 'Held for you because this draft was never scored.',
    };
  }
  if (score < input.threshold) {
    return {
      ok: false,
      reason: 'score',
      message: 'Held for you because it scored ' + score + ' out of 100, below the ' + input.threshold + ' this account sends unattended.',
    };
  }

  // 4. Any safety flag at all. A flag is the rubric saying a person should look.
  const flags = Number(input.safetyFlags) || 0;
  if (flags > 0) {
    return {
      ok: false,
      reason: 'safety',
      message: 'Held for you because the safety review raised ' + flags + (flags === 1 ? ' flag' : ' flags') + ' on this copy.',
    };
  }

  // 5. A network that refuses a text-only post, with nothing to show.
  const needing = networks.filter((n) => NETWORKS_NEEDING_MEDIA.has(n));
  if (needing.length && !input.hasMedia) {
    return {
      ok: false,
      reason: 'media',
      message: 'Held for you because ' + needing.join(' and ') + ' will not take a post with no image or video, and this one has neither.',
    };
  }

  return { ok: true };
}

/** The line that goes on the run's card. '' when it may go. */
export function holdNote(verdict: AutoScheduleVerdict): string {
  return verdict.ok ? '' : verdict.message;
}
