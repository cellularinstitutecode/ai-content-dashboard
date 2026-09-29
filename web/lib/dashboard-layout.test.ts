// The main page's right-hand panel: the "How this works" guide and the stat
// cards, in a column the same width as the menu on the left (w-60), kept in
// view while the page scrolls; below 1280px it stacks on top as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');

test('the guide and the counts sit in a right-hand panel the width of the menu', () => {
  assert.match(page, /<aside className="hidden w-60 shrink-0 lg:block">/, 'the menu is w-60');
  assert.match(page, /<div className="xl:flex xl:flex-row-reverse xl:items-start xl:gap-8">\n<aside aria-label="Guide and counts" className="xl:sticky xl:top-8 xl:w-60 xl:shrink-0">/);
  const panel = page.slice(page.indexOf('<aside aria-label="Guide and counts"'), page.indexOf('</aside>', page.indexOf('<aside aria-label="Guide and counts"')));
  assert.match(panel, />How this works</, 'the guide');
  assert.match(panel, /statCards\.map/, 'the counts');
  // The status and error messages live in the main column, so the panel starts at the top.
  const main = page.slice(page.indexOf('<div className="min-w-0 flex-1">'));
  assert.ok(main.indexOf('<SystemStatus />') > 0 && main.indexOf('<SystemStatus />') < main.indexOf('{/* Generator */}'));
});

test('the counts show on the Draft page too, not only on the Dashboard', () => {
  const at = page.indexOf('{statCards.map');
  const before = page.slice(page.lastIndexOf('{/* Stat cards', at), at);
  assert.doesNotMatch(before, /!isDraft/);
});
