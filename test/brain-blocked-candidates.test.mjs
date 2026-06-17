// Path A (2026-05-13): blocked sigs must appear INSIDE the system message,
// not just the user-message banner the LLM has been ignoring. Verdict in
// AI/drafts/2026-05-12-overnight-full-fleet-report.md (§S4): the prereq hint
// in the goal field is "informationally correct but operationally inert"; the
// candidate set itself has to be modified at the point of selection.
//
// Run with:  node --test test/brain-blocked-candidates.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSystemPrompt } from '../src/bots/brain.js';

const FUTURE = Date.now() + 5 * 60_000;

function sig(skill, args, opts = {}) {
  return [
    skill + ':' + args,
    {
      until:     opts.until ?? FUTURE,
      lastError: opts.lastError ?? '',
      label:     opts.label ?? `${skill}(${args})`,
    },
  ];
}

test('empty / null input returns the base SYSTEM_PROMPT unchanged', () => {
  const base = buildSystemPrompt(new Map());
  assert.ok(base.includes('Available skills (use exactly these names):'));
  assert.equal(base.includes('[BLOCKED this turn'), false);
  assert.equal(buildSystemPrompt(null),      base);
  assert.equal(buildSystemPrompt(undefined), base);
});

test('annotates the matching skill line with the blocked sig', () => {
  const blocked = new Map([
    sig('craft', 'item=wooden_pickaxe,count=1', { lastError: 'missing 2x stick' }),
  ]);
  const prompt = buildSystemPrompt(blocked);

  assert.ok(prompt.includes('[BLOCKED this turn'),               'annotation block emitted');
  assert.ok(prompt.includes('craft(item=wooden_pickaxe,count=1)'), 'sig label inline');
  assert.ok(prompt.includes('missing 2x stick'),                  'last error inline');

  // Annotation must sit between the craft line and the next skill line — i.e.
  // attached to craft, not floating somewhere else.
  const craftIdx = prompt.indexOf('- craft ');
  const smeltIdx = prompt.indexOf('- smelt ');
  const annIdx   = prompt.indexOf('[BLOCKED this turn');
  assert.ok(craftIdx > 0,                  'craft line present');
  assert.ok(smeltIdx > craftIdx,           'smelt line follows craft');
  assert.ok(annIdx > craftIdx && annIdx < smeltIdx,
    'annotation is wedged between craft and smelt');
});

test('multiple sigs for the same skill collapse into one annotation block', () => {
  const blocked = new Map([
    sig('craft', 'item=wooden_pickaxe,count=1', { lastError: 'missing 2x stick' }),
    sig('craft', 'item=crafting_table,count=1', { lastError: 'missing 4x any plank' }),
  ]);
  const prompt = buildSystemPrompt(blocked);

  const annCount = (prompt.match(/\[BLOCKED this turn/g) || []).length;
  assert.equal(annCount, 1, 'one annotation per skill, not one per sig');
  assert.ok(prompt.includes('craft(item=wooden_pickaxe,count=1)'));
  assert.ok(prompt.includes('craft(item=crafting_table,count=1)'));
});

test('different skills get independent annotations', () => {
  const blocked = new Map([
    sig('craft',       'item=wooden_pickaxe,count=1', { lastError: 'missing 2x stick' }),
    sig('place_block', 'block=crafting_table',         { lastError: 'no crafting_table in inventory' }),
  ]);
  const prompt = buildSystemPrompt(blocked);

  const annCount = (prompt.match(/\[BLOCKED this turn/g) || []).length;
  assert.equal(annCount, 2);
  assert.ok(prompt.includes('craft(item=wooden_pickaxe,count=1)'));
  assert.ok(prompt.includes('place_block(block=crafting_table)'));
});

test('expired sigs are dropped — annotation only mentions live ones', () => {
  const blocked = new Map([
    sig('craft', 'item=wooden_pickaxe,count=1', { until: Date.now() - 1, lastError: 'stale' }),
  ]);
  const prompt = buildSystemPrompt(blocked);
  assert.equal(prompt.includes('[BLOCKED this turn'),               false);
  assert.equal(prompt.includes('craft(item=wooden_pickaxe,count=1)'), false);
});

test('place_block annotation does not bleed into place_block_at', () => {
  const blocked = new Map([
    sig('place_block', 'block=cobblestone', { lastError: 'no solid surface' }),
  ]);
  const prompt = buildSystemPrompt(blocked);

  const placeBlockIdx   = prompt.indexOf('- place_block ');
  const placeBlockAtIdx = prompt.indexOf('- place_block_at ');
  const annIdx          = prompt.indexOf('[BLOCKED this turn');
  assert.ok(placeBlockIdx   > 0);
  assert.ok(placeBlockAtIdx > placeBlockIdx);
  assert.ok(annIdx > placeBlockIdx && annIdx < placeBlockAtIdx,
    'annotation attached to place_block, not place_block_at');
});
