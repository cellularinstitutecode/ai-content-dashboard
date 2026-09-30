// web/lib/mobile-layout.test.ts
// The spacing is dynamic: a phone gets a phone's paddings, menu and calendar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('phone widths cut the desktop paddings down instead of squeezing the content', () => {
  const css = src('app/globals.css');
  const phone = css.slice(css.indexOf('@media (max-width: 640px)'));
  for (const rule of ['.px-6 { padding-left: 1rem', '.py-8 { padding-top: 1.25rem', '.p-6 { padding: 1rem', '.gap-8 { gap: 1.25rem', '.rounded-3xl { border-radius: 1.125rem', '.text-title { font-size: 24px']) {
    assert.ok(phone.includes(rule), rule);
  }
  assert.match(phone, /html \{ overflow-x: clip; \}/, 'nothing pushes the page sideways');
  assert.match(phone, /\.cal-month \{ grid-template-columns: repeat\(7, minmax\(92px, 1fr\)\); overflow-x: auto;/, 'the month is swiped, not crushed');
});

test('the dashboard: a swipeable menu with Sign out, the tour folded and below the work on a phone', () => {
  const page = src('app/page.tsx');
  assert.match(page, /px-4 py-5 sm:px-6 sm:py-8 lg:px-10/);
  assert.match(page, /overflow-x-auto px-4 pb-1 lg:hidden/);
  assert.match(page, /<a href="\/sign-out" className="shrink-0 whitespace-nowrap/, 'Sign out reachable on a phone');
  assert.match(page, /flex flex-col-reverse xl:flex-row-reverse/, 'the guide after the work below xl');
  assert.match(page, /window\.innerWidth < 1024\) setOnboardOpen\(false\)/, 'folded by default on a narrow screen');
});

test('the calendar and the assistant fit a phone', () => {
  const cal = src('app/calendar/page.tsx');
  assert.match(cal, /className="cal-month grid grid-cols-7 gap-2"/);
  assert.match(cal, /px-4 py-5 sm:px-6 sm:py-8 lg:grid-cols-\[minmax\(0,1fr\)_380px\]/);
  assert.match(cal, /mb-5 flex flex-wrap items-center justify-between gap-2/);
  const panel = src('components/DraftingAssistant.tsx');
  assert.match(panel, /max-h-\[calc\(100dvh-2rem\)\] w-\[380px\] max-w-\[calc\(100vw-2rem\)\]/);
  assert.match(panel, /bottom-4 right-4 z-50[^"]*sm:bottom-6 sm:right-6/);
});
