// web/lib/media-filename.ts
// A name the transcription endpoint can demux from.
//
// OpenAI's audio endpoint decides how to read an upload from its FILENAME, and
// refuses one whose name carries no extension it recognises. Drive names are
// people's names for things — "Reel_#4TPExRyall_Rodrigo.mp4" — so they are
// also sanitised here for a multipart part header. Pure, so it is unit-tested.

const EXT_FOR: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/mpeg': 'mpeg',
  'video/x-m4v': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
};

/** A name the transcription endpoint can demux from — its own, when it already has a usable extension. */
export function filenameFor(name: string, contentType: string): string {
  const safe = String(name || 'video').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'video';
  if (/\.(mp4|mov|webm|mpeg|mpga|mp3|m4a|wav|ogg|flac)$/i.test(safe)) return safe;
  const ext = EXT_FOR[String(contentType).toLowerCase().split(';')[0]] || 'mp4';
  return safe.replace(/\.$/, '') + '.' + ext;
}
