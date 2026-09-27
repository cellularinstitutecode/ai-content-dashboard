import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ARTICLE_LINK_PLACEHOLDER, articleLogNote, articleUrl, readArticleLog, withArticleLink } from './article-promo.ts';

const REF = 'REF: Smith, A. (2020). "Evaluation." J Med. DOI: 10.1000/x';
const AVISO = 'AVISO DE PUBLICIDAD: 2623022002A00090';

test('the link goes above the citation and the notice, which stay last', () => {
  const promo = 'Why does a thorough evaluation matter?\n\n#health\n\n' + REF + '\n\n' + AVISO;
  const out = withArticleLink(promo, 'https://clinic.example/why-evaluation/');
  const lines = out.split('\n').filter(Boolean);
  assert.equal(lines[lines.length - 1], AVISO);
  assert.equal(lines[lines.length - 2], REF);
  assert.equal(lines[lines.length - 3], 'Read the full article: https://clinic.example/why-evaluation/');
});

test('whatever link the writer guessed is removed', () => {
  const promo = 'Read more at https://placeholder.example/article (link in bio).\n\n' + REF;
  const out = withArticleLink(promo, 'https://clinic.example/real/');
  assert.doesNotMatch(out, /placeholder\.example/);
  assert.doesNotMatch(out, /link in bio/i);
  assert.match(out, /Read the full article: https:\/\/clinic\.example\/real\//);
});

test('the URL is WordPress\'s permalink, or the ?p= form a draft has', () => {
  assert.equal(articleUrl({ id: 7, link: 'https://clinic.example/a/' }, 'https://clinic.example'), 'https://clinic.example/a/');
  assert.equal(articleUrl({ id: 7, link: '' }, 'https://clinic.example/'), 'https://clinic.example/?p=7');
  assert.equal(articleUrl({ id: 7 }, ''), '');
});

test('a published article is read back from the run log, so a retry does not publish it twice', () => {
  const note = articleLogNote({ id: 42, status: 'future' }, 'https://clinic.example/?p=42');
  assert.ok(note.length < 400, 'fits the log column');
  const log = [{ step: 'research', note: 'x' }, { step: 'article', note }, { step: 'approve-failed', note: 'Metricool down' }];
  assert.deepEqual(readArticleLog(log), { id: 42, url: 'https://clinic.example/?p=42' });
  assert.equal(readArticleLog([{ step: 'sent', note }]), null);
  assert.equal(readArticleLog(null), null);
});

test('the stand-in link used for the length check is at least as long as a real one', () => {
  assert.ok(ARTICLE_LINK_PLACEHOLDER.length >= 90);
});
