import test from 'node:test';
import assert from 'node:assert/strict';
import { PACK_SCHEMA, supportsJsonOutput } from './anthropic-models.ts';

test('the current models get structured output; older ones get the plain request', () => {
  for (const m of ['claude-sonnet-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-haiku-4-5', 'claude-fable-5-1', 'claude-sonnet-5-20260901']) {
    assert.equal(supportsJsonOutput(m, {}), true, m);
  }
  for (const m of ['claude-sonnet-4-5', 'claude-sonnet-4-6', 'claude-opus-4-6', 'claude-3-5-sonnet-latest', '', 'gpt-4o-mini']) {
    assert.equal(supportsJsonOutput(m, {}), false, m || '(empty)');
  }
});

test('a prefix is not enough on its own — claude-sonnet-50 is not claude-sonnet-5', () => {
  assert.equal(supportsJsonOutput('claude-sonnet-50', {}), false);
});

test('ANTHROPIC_JSON_OUTPUT=off switches it off without a deploy', () => {
  assert.equal(supportsJsonOutput('claude-sonnet-5', { ANTHROPIC_JSON_OUTPUT: 'off' }), false);
  assert.equal(supportsJsonOutput('claude-sonnet-5', { ANTHROPIC_JSON_OUTPUT: 'on' }), true);
});

test('the schema is the four pack keys, all required, nothing else allowed', () => {
  assert.deepEqual(Object.keys(PACK_SCHEMA.properties), ['instagram', 'facebook', 'linkedin', 'blog']);
  assert.deepEqual([...PACK_SCHEMA.required], ['instagram', 'facebook', 'linkedin', 'blog']);
  assert.equal(PACK_SCHEMA.additionalProperties, false);
});
