// "Drop weekly strategy": what the model reads out of a PDF becomes Autopilot
// slots — clamped, additive, never written twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { MAX_ANGLES, MAX_SLOTS, UPLOAD_MARK, UPLOAD_SCHEMA, normalizeUpload, planUpload, ruleFor, timeOf, uploadRows, uploadSummary } from './strategy-upload.ts';
import { normalizeStrategy } from './template-strategy.ts';
import { citationPolicyFor, isStrategySlot } from './strategy-voice.ts';

// Trimmed from what the reader returns for the clinic's own document.
const READ = {
  title: 'Cellular Institute — Weekly Social Content Strategy',
  summary: 'Fourteen posts a week, two a day, rotating pillars.',
  direction: 'Educational and personalized; no cure claims.',
  slots: [
    { day: 'mon', time: '09:00', pillar: 'Diagnosis and comprehensive assessment', angles: ['Why assessment comes first', 'What a full panel shows'], format: 'social', channels: ['instagram', 'facebook', 'linkedin'], rule: '' },
    { day: 'mon', time: '', pillar: 'Personalized protocols', angles: ['One size does not fit all'], format: 'social', channels: [], rule: 'Never promise identical outcomes.' },
    { day: 'mon', time: '', pillar: 'Weekly article', angles: ['The science of recovery'], format: 'blog', channels: ['blog'], rule: '' },
    { day: 'sun', time: '6:30 PM', pillar: 'Recovery in Cancun', angles: ['Rest by the sea', 'rest by the sea'], format: 'social', channels: ['instagram', 'tiktok'], rule: '' },
    { day: 'funday', time: '09:00', pillar: 'Lost', angles: [], format: 'social', channels: [], rule: '' },
    { day: 'tue', time: '09:00', pillar: '', angles: [], format: 'social', channels: [], rule: '' },
  ],
};

test('times in the ways a document writes them', () => {
  assert.equal(timeOf('09:00'), '09:00');
  assert.equal(timeOf('9:00'), '09:00');
  assert.equal(timeOf('9am'), '09:00');
  assert.equal(timeOf('6:30 PM'), '18:30');
  assert.equal(timeOf('12 am'), '00:00');
  assert.equal(timeOf('18.00'), '18:00');
  assert.equal(timeOf('9'), null, 'a bare number is not a time');
  assert.equal(timeOf('25:00'), null);
  assert.equal(timeOf(''), null);
});

test('the reader\'s answer is made safe: days, times, channels, angles', () => {
  const p = normalizeUpload(READ);
  assert.equal(p.slots.length, 4, 'the slot with no day and the one with no pillar are dropped');
  assert.equal(p.notes.length, 2);
  // Monday first, Sunday last.
  assert.deepEqual(p.slots.map((s) => s.weekday), [1, 1, 1, 0]);
  const [diag, article, protocols, sunday] = p.slots;
  assert.equal(diag.time, '09:00');
  assert.equal(article.format, 'blog');
  assert.equal(article.time, '11:00', 'an article without a time gets the article hour');
  assert.deepEqual(article.providers, ['blog', 'facebook', 'linkedin']);
  assert.equal(protocols.time, '18:00', 'the second social post of the day without a time gets 18:00');
  assert.deepEqual(protocols.providers, ['instagram', 'facebook', 'linkedin'], 'no channels named → the three');
  assert.equal(sunday.time, '18:30');
  assert.deepEqual(sunday.providers, ['instagram'], 'a channel the dashboard does not publish to is dropped');
  assert.deepEqual(sunday.angles, ['Rest by the sea'], 'angles de-duplicated');
});

test('an empty or hostile answer yields nothing to create', () => {
  assert.equal(normalizeUpload(null).slots.length, 0);
  assert.equal(normalizeUpload({ slots: 'x' }).slots.length, 0);
  const many = normalizeUpload({ slots: Array.from({ length: 40 }, (_, i) => ({ day: 'mon', time: String(i % 24).padStart(2, '0') + ':' + String(i).padStart(2, '0'), pillar: 'P' + i, angles: Array.from({ length: 30 }, (_, j) => 'a' + j) })) });
  assert.equal(many.slots.length, MAX_SLOTS);
  assert.ok(many.slots.every((s) => s.angles.length === MAX_ANGLES));
});

test('rows are pillars templates the engine reads back unchanged, marked as uploaded', () => {
  const rows = uploadRows(normalizeUpload(READ));
  for (const r of rows) {
    assert.equal(r.active, true);
    assert.equal(r.strategy.mode, 'pillars');
    assert.equal(r.strategy.seeded, UPLOAD_MARK);
    const n = normalizeStrategy(r.strategy);
    assert.equal(n.mode, 'pillars');
    assert.equal(n.seeded, UPLOAD_MARK);
    assert.deepEqual(n.pillars, r.strategy.pillars);
    assert.equal(n.slot, undefined, 'never mistaken for one of the built-in strategy\'s slots');
  }
  assert.match(String(rows.find((r) => r.name === 'Personalized protocols')?.strategy.rule), /Never promise identical outcomes\. The strategy's editorial direction: Educational/);
  assert.ok((ruleFor({ weekday: 1, time: '09:00', pillar: 'x', angles: [], format: 'social', providers: [], rule: 'r'.repeat(900) }, 'd') || '').length <= 800);
});

test('uploaded slots cite a study only when a post makes a health claim, and are not the built-in strategy', () => {
  const s = uploadRows(normalizeUpload(READ))[0].strategy;
  assert.equal(citationPolicyFor(s), 'if-health-claim');
  assert.equal(isStrategySlot(s), false);
  assert.equal(citationPolicyFor({ seeded: undefined }), 'required', 'everything else unchanged');
});

test('insert-only: an earlier upload is skipped, a clash is reported, nothing is updated', () => {
  const plan = normalizeUpload(READ);
  const existing = [
    { name: 'Diagnosis and comprehensive assessment', weekdays: [1], time_of_day: '09:00:00', active: true, strategy: { seeded: UPLOAD_MARK } },
    { name: 'Nutrition', weekdays: [0], time_of_day: '18:30', active: true, strategy: { seeded: 'weekly-strategy' } },
    { name: 'Paused one', weekdays: [1], time_of_day: '18:00', active: false, strategy: {} },
  ];
  const p = planUpload(plan, existing);
  assert.equal(p.already.length, 1);
  assert.equal(p.create.length, 3);
  assert.deepEqual(p.clashes, [{ slot: 'Sunday 18:30 · Recovery in Cancun', with: 'Nutrition' }], 'a paused template is no clash');
  assert.deepEqual(Object.keys(p).sort(), ['already', 'clashes', 'create']);
  assert.match(uploadSummary(p), /3 weekly slots created.*review queue/);
});

test('the schema is closed and asks for every key', () => {
  assert.equal(UPLOAD_SCHEMA.additionalProperties, false);
  assert.equal(UPLOAD_SCHEMA.properties.slots.items.additionalProperties, false);
  assert.deepEqual([...UPLOAD_SCHEMA.properties.slots.items.required].sort(), Object.keys(UPLOAD_SCHEMA.properties.slots.items.properties).sort());
});

test('the route reads the PDF with Claude, then inserts only — and the panel is on both pages', () => {
  const route = readFileSync(new URL('../app/api/templates/strategy-upload/route.ts', import.meta.url), 'utf8');
  assert.match(route, /type: 'document', source: \{ type: 'base64', media_type: 'application\/pdf'/);
  assert.match(route, /output_config: \{ format: \{ type: 'json_schema', schema: UPLOAD_SCHEMA \} \}/);
  assert.match(route, /checkRateLimit\(auth\.userId, 'templates'\)/);
  assert.match(route, /requireAllowlistedUser\(\)/);
  assert.match(route, /normalizeUpload\(body\.plan\)/, 'the plan sent back is never trusted as it arrives');
  assert.match(route, /\.insert\(insert\)/);
  assert.doesNotMatch(route, /\.update\(|\.delete\(|\.upsert\(/, 'additive: nothing existing is changed');
  const page = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /\{!isDraft && <StrategyDrop \/>\}/);
  // The top panel on the overview: above the panels grid and every other panel.
  const drop = page.indexOf('{!isDraft && <StrategyDrop />}');
  assert.ok(drop < page.indexOf('<SystemStatus />'), 'above the status banner too');
  assert.ok(drop < page.indexOf('<div className="2xl:grid 2xl:grid-cols-2'), 'before the panels grid');
  assert.equal(page.split('<StrategyDrop').length, 2, 'mounted once');
  const templates = readFileSync(new URL('../app/templates/page.tsx', import.meta.url), 'utf8');
  assert.match(templates, /<StrategyDrop onCreated=/);
  assert.match(templates, /<WeeklyPlanner/, 'the built-in strategy loader stays');
});
