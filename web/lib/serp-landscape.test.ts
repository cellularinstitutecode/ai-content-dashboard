import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDomain, serpLandscapeFrom, themesFrom, type SerpRow } from './serp-landscape.ts';

/** The live top 10 for "hyperbaric oxygen therapy" (us), pulled while designing this. */
const INSTITUTIONAL: SerpRow[] = [
  { domain: 'www.mayoclinic.org', url: 'https://www.mayoclinic.org/tests-procedures/hyperbaric-oxygen-therapy/about/pac-20394380' },
  { domain: 'www.hopkinsmedicine.org', url: 'https://www.hopkinsmedicine.org/health/treatment-tests-and-therapies/hyperbaric-oxygen-therapy' },
  { domain: 'pmc.ncbi.nlm.nih.gov', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC8465921/' },
  { domain: 'my.clevelandclinic.org', url: 'https://my.clevelandclinic.org/health/treatments/17811-hyperbaric-oxygen-therapy' },
  { domain: 'www.unitypoint.org', url: 'https://www.unitypoint.org/find-a-service/therapy-and-rehabilitation/hyperbaric-oxygen-therapy' },
  { domain: 'medlineplus.gov', url: 'https://medlineplus.gov/oxygentherapy.html' },
];

/** And the live top 10 for "stem cell therapy mexico" — a completely different fight. */
const PEERS: SerpRow[] = [
  { domain: 'www.stemcellmexico.org', url: 'https://www.stemcellmexico.org/' },
  { domain: 'www.longevity-institute.com', url: 'https://www.longevity-institute.com/treatments-resources/best-stem-cell-clinic-in-mexico' },
  { domain: 'r3stemcell.com', url: 'https://r3stemcell.com/cost-of-stem-cell-treatment-in-mexico/' },
  { domain: 'stemcellmedicalcenter.com', url: 'https://stemcellmedicalcenter.com/travel-overview/stem-cell-treatment-mexico/' },
  { domain: 'giostarmexico.com', url: 'https://giostarmexico.com/licensed-stem-cell-therapy-in-mexico/' },
  { domain: 'www.youtube.com', url: 'https://www.youtube.com/watch?v=AaDxXAxFC_o' },
];

test('a hospital, a journal, a rival clinic and a video are told apart', () => {
  assert.equal(classifyDomain('www.mayoclinic.org'), 'institution');
  assert.equal(classifyDomain('pmc.ncbi.nlm.nih.gov'), 'reference');
  assert.equal(classifyDomain('medlineplus.gov'), 'reference');
  assert.equal(classifyDomain('r3stemcell.com'), 'clinic');
  // A brand name with no telltale word is honestly 'other' — the posture below
  // must not depend on being able to name every competitor.
  assert.equal(classifyDomain('giostarmexico.com'), 'other');
  assert.equal(classifyDomain('www.youtube.com'), 'social');
});

test('the named lists win over the loose clinic pattern', () => {
  // hopkinsMEDICINE and clevelandCLINIC both match the peer-clinic regex. If
  // ordering slipped, Johns Hopkins would be filed as a rival day spa and the
  // post would be told to out-specify it rather than not out-explain it.
  assert.equal(classifyDomain('www.hopkinsmedicine.org'), 'institution');
  assert.equal(classifyDomain('my.clevelandclinic.org'), 'institution');
  assert.equal(classifyDomain('usmexicostemcellinstitute.com'), 'clinic', 'contains "institute" but is a competitor');
});

test('against Mayo and the NIH: do not try to out-explain them', () => {
  const out = serpLandscapeFrom('hyperbaric oxygen therapy', INSTITUTIONAL);
  assert.match(out, /will not out-explain them/);
  assert.match(out, /never show one clinic actually doing the thing/);
  assert.ok(!/rival clinics selling the same treatment/.test(out));
});

test('against rival clinics: stop claiming, start showing', () => {
  // The opposite instruction, from the same function, on the same clinic's
  // other keyword. This is the whole reason the file exists.
  const out = serpLandscapeFrom('stem cell therapy mexico', PEERS);
  assert.match(out, /rival clinics selling the same treatment/);
  assert.match(out, /VERIFIABLE from this video/);
  assert.ok(!/out-explain/.test(out));
});

test('unrecognisable competitors do not let two institutions outvote eight rivals', () => {
  // giostarmexico, stemcellmexico and the rest carry nothing in their domains
  // to mark them as clinics. Counting them neutral would have handed a page of
  // direct competitors the "do not out-explain Mayo Clinic" instruction.
  const mostlyUnknown: SerpRow[] = [
    { domain: 'giostarmexico.com', url: 'https://giostarmexico.com/' },
    { domain: 'brandnamehere.com', url: 'https://brandnamehere.com/' },
    { domain: 'anotherbrand.mx', url: 'https://anotherbrand.mx/' },
    { domain: 'medlineplus.gov', url: 'https://medlineplus.gov/x.html' },
  ];
  assert.match(serpLandscapeFrom('x', mostlyUnknown), /rival clinics selling the same treatment/);
});

test('the slugs give up what the competitors are worried about', () => {
  // A page's path is chosen to match the query it wants, which makes it an
  // unusually honest statement of what its visitors are anxious about.
  const themes = themesFrom(PEERS);
  assert.ok(themes.includes('being called the best'));
  assert.ok(themes.includes('what it costs'));
  assert.ok(themes.includes('whether it is legitimate and safe'));
  assert.ok(themes.includes('the logistics of travelling for treatment'));
});

test('a competitor is never named in the copy, whatever the landscape', () => {
  // Comparative advertising is separately regulated, and a medical advertiser
  // naming a rival is a problem this pipeline must not be able to create.
  for (const rows of [INSTITUTIONAL, PEERS]) {
    assert.match(serpLandscapeFrom('x', rows), /NEVER name a competitor/);
    assert.match(serpLandscapeFrom('x', rows), /comparative claim/);
  }
});

test('no SERP data is a quieter post, never a failed one', () => {
  assert.equal(serpLandscapeFrom('anything', []), '');
  assert.equal(serpLandscapeFrom('', PEERS), '');
  assert.equal(serpLandscapeFrom('x', [{ domain: '', url: '' }]), '');
});
