import test from 'node:test';
import assert from 'node:assert/strict';
import { METRICOOL_BLOG_ID, METRICOOL_USER_ID, metricoolPlannerUrl } from './metricool-links.ts';

test('every planner link carries BOTH ids', () => {
  // The whole point of this module. Metricool resolves a brand only inside a
  // user, so a link with blogId alone opens its "there was an error that
  // prevented loading the page" — which is what happened, and what a second
  // copy of this URL somewhere else would bring back.
  const u = new URL(metricoolPlannerUrl('4308292'));
  assert.equal(u.searchParams.get('blogId'), '4308292');
  assert.equal(u.searchParams.get('userId'), METRICOOL_USER_ID);
});

test('it is the planner calendar on Metricool, over https', () => {
  const u = new URL(metricoolPlannerUrl());
  assert.equal(u.protocol, 'https:');
  assert.equal(u.host, 'app.metricool.com');
  assert.equal(u.pathname, '/planner/calendar');
});

test('an empty or blank brand falls back to the clinic default, never to nothing', () => {
  for (const bad of ['', '   ', null, undefined]) {
    assert.equal(new URL(metricoolPlannerUrl(bad as string)).searchParams.get('blogId'), METRICOOL_BLOG_ID);
  }
});

test('a brand id is encoded, not interpolated raw', () => {
  const u = new URL(metricoolPlannerUrl('a b&c=d'));
  assert.equal(u.searchParams.get('blogId'), 'a b&c=d');
  assert.equal(u.searchParams.get('userId'), METRICOOL_USER_ID);
});
