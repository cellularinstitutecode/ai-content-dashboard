// web/lib/cover-title.ts
// The words a draft's cover carries, decided once per draft.
//
// Covers used to wear a fixed title: the planner's table entry for the angle,
// or — for any other draft — the draft's topic, which for a video post is the
// video's own name ("Cellular Hope Day" on a post about body composition).
// Now the title is WRITTEN from the post, in the feed's voice
// (lib/cover-edit.ts TITLE_STYLE_EXAMPLES), and then kept on the pack as
// `_coverTitle` so every later picture of the same draft — a library photo,
// a new AI take, a retitle — wears the same words unless a person changes
// them. The static title is the fallback when no model answers.
import 'server-only';
import { coverTitleFor } from './library-cover.ts';
import { cleanTopic, plannerImageFor } from './planner-image.ts';
import { cleanCoverTitle } from './cover-edit.ts';
import { briefSource } from './image-brief.ts';
import { writeCoverTitle } from './title-suggest.ts';

export type ResolvedTitle = {
  title: string;
  /** True when the model wrote it just now, so the caller should keep it on the pack. */
  written: boolean;
};

/**
 * In order: the words a person set (or turned off) on the current picture;
 * the title already kept on the pack; the words already painted on the
 * current picture; a title written from the post; the static fallback.
 */
export async function resolveCoverTitle(input: { pack: Record<string, unknown>; topic: string }): Promise<ResolvedTitle> {
  const pack = input.pack || {};
  const image = (pack as { _image?: { titled?: { title?: unknown; custom?: unknown } | null } })._image;
  if (image?.titled?.custom === true) return { title: cleanCoverTitle(image.titled.title), written: false };
  const kept = cleanCoverTitle((pack as { _coverTitle?: unknown })._coverTitle);
  if (kept) return { title: kept, written: false };
  const painted = cleanCoverTitle(image?.titled?.title);
  if (painted) return { title: painted, written: false };
  const planner = plannerImageFor(pack);
  const written = await writeCoverTitle({
    angle: planner?.subject || cleanTopic(input.topic),
    pillarName: planner?.pillarName || null,
    copy: briefSource(pack),
  });
  if (written) return { title: written, written: true };
  return { title: coverTitleFor(pack, input.topic), written: false };
}
