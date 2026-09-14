// web/lib/sheet-zoom.ts
// Zooming an embedded Google Sheet, and knowing when it may scroll.
//
// Two complaints from the Video Library, both about the framed sheet:
//
//   1. "I'm scrolling down and the sheet also scrolls down." The frame is as
//      tall as the window, so the mouse is over it most of the time, and a
//      framed page takes every wheel event under the cursor. Scrolling the
//      page became a fight with the sheet. So the frame is INERT until the
//      person clicks into it, and goes inert again the moment the mouse
//      leaves — the same convention embedded maps use. Page scrolls when
//      you mean the page; sheet scrolls when you are in the sheet.
//
//   2. "Put a magnifier so I can zoom in and out at will." Google's embed has
//      no zoom parameter, but the frame can be scaled: draw it 1/zoom as wide
//      and tall, scale it by zoom, and it fills the same box with bigger or
//      smaller cells. The numbers for that live here so they are tested
//      rather than guessed.
//
// Pure and import-free: the test runner strips types and runs this file
// directly, and a frame drawn at the wrong size is a sheet you cannot read.

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 1.5;
export const ZOOM_STEP = 0.1;
export const ZOOM_DEFAULT = 1;

/** A usable zoom: numeric, within range, two decimals — or the default. */
export function clampZoom(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isFinite(n) || n <= 0) return ZOOM_DEFAULT;
  const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, n));
  return Math.round(clamped * 100) / 100;
}

export function zoomIn(zoom: number): number {
  return clampZoom(clampZoom(zoom) + ZOOM_STEP);
}

export function zoomOut(zoom: number): number {
  return clampZoom(clampZoom(zoom) - ZOOM_STEP);
}

/** "80%", never "0.8000000001%". */
export function zoomLabel(zoom: number): string {
  return Math.round(clampZoom(zoom) * 100) + '%';
}

/** The localStorage key one sheet's zoom is remembered under. */
export function zoomStorageKey(sheetId: string): string {
  return 'chi:sheet-zoom:' + String(sheetId || '').trim();
}

/** What a remembered value means; anything unreadable is the default. */
export function readStoredZoom(raw: string | null | undefined): number {
  return clampZoom(raw);
}

export type FrameGeometry = {
  /** Percent of the container's width the frame is drawn at, before scaling. */
  widthPercent: number;
  /** Pixel height the frame is drawn at, before scaling. */
  height: number;
  /** The CSS transform that brings it back to the container's size. */
  transform: string;
};

/**
 * How to draw the frame so that, scaled by `zoom`, it exactly fills a box of
 * the container's width and `boxHeight` pixels.
 *
 * At 50% the frame is drawn twice as wide and tall and shrunk by half — more
 * columns and rows fit. At 150% it is drawn at two thirds and enlarged — the
 * cells are readable from across the room. The box the person sees never
 * changes size, so the page layout does not jump when zooming.
 */
export function frameGeometry(zoom: number, boxHeight: number): FrameGeometry {
  const z = clampZoom(zoom);
  const h = Math.max(0, Number(boxHeight) || 0);
  return {
    widthPercent: Math.round((100 / z) * 100) / 100,
    height: Math.round(h / z),
    transform: 'scale(' + z + ')',
  };
}
