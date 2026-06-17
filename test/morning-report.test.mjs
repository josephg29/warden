import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregateCrafts,
  aggregateDeaths,
  topSignatures,
  aggregateBrainStatus,
  aggregateSupervisor,
} from '../scripts/morning-report.mjs';

const fixtureEvents = [
  {
    ts: '2026-05-16T00:00:00.000Z',
    type: 'brain:skill_done',
    botId: 'botA',
    data: {
      skill: 'craft',
      args: { item: 'wooden_pickaxe', count: 1 },
      outcome: { ok: true, crafted: '1x wooden_pickaxe' },
    },
  },
  {
    ts: '2026-05-16T00:01:00.000Z',
    type: 'brain:skill_done',
    botId: 'botA',
    data: {
      skill: 'craft',
      args: { item: 'stick', count: 4 },
      outcome: { ok: true, crafted: '4x stick' },
    },
  },
  // failed craft must be ignored
  {
    ts: '2026-05-16T00:02:00.000Z',
    type: 'brain:skill_done',
    botId: 'botA',
    data: {
      skill: 'craft',
      args: { item: 'furnace', count: 1 },
      outcome: { ok: false },
    },
  },
  {
    ts: '2026-05-16T00:03:00.000Z',
    type: 'brain:death',
    botId: 'botA',
    location: { x: 10, y: 64, z: -5 },
  },
  {
    ts: '2026-05-16T00:04:00.000Z',
    type: 'brain:decision',
    botId: 'botA',
    data: { action: { type: 'wait', args: { seconds: 3 } } },
  },
];

test('aggregateCrafts picks up craft events and ignores failures', () => {
  const out = aggregateCrafts(fixtureEvents);
  assert.equal(out.byItem.get('wooden_pickaxe').total, 1);
  assert.equal(out.byItem.get('stick').total, 4);
  assert.equal(out.byItem.has('furnace'), false);
  assert.equal(out.byItem.get('wooden_pickaxe').byBot.get('botA'), 1);
});

test('aggregateDeaths picks up death events and tallies location', () => {
  const out = aggregateDeaths(fixtureEvents);
  assert.equal(out.count, 1);
  assert.deepEqual(out.topLocations[0], ['10,64,-5', 1]);
});

test('topSignatures counts decisions and recentDecisions', () => {
  const state = {
    slots: [
      { recentDecisions: [
        { ts: 1, sig: 'wait:{"seconds":3}' },
        { ts: 2, sig: 'wait:{"seconds":3}' },
      ] },
    ],
  };
  const out = topSignatures(state, fixtureEvents, 5);
  const [topSig, topN] = out[0];
  assert.equal(topSig, 'wait:{"seconds":3}');
  assert.equal(topN, 3);
});

test('aggregateBrainStatus categorises restart triggers', () => {
  const overnight = [
    { event: 'restart_begin', reason: 'brain_stalled', evidence: { brainStatus: 'stalled' } },
    { event: 'restart_begin', reason: 'brain_stalled', evidence: { lastBrainError: { message: 'Cerebras API rate-limited (429).' } } },
    { event: 'restart_begin', reason: 'mass_disconnect' },
    { event: 'restart_begin', reason: 'stuck_loop' },
  ];
  const state = { slots: [{ disconnectedSince: null }, { disconnectedSince: 1 }] };
  const out = aggregateBrainStatus(overnight, state);
  assert.equal(out.triggerTally.stalled, 1);
  assert.equal(out.triggerTally.llm_backoff, 1);
  assert.equal(out.triggerTally.disconnected, 1);
  assert.equal(out.triggerTally.running, 1);
  assert.equal(out.snapshot.connected, 1);
  assert.equal(out.snapshot.disconnected, 1);
});

test('aggregateSupervisor counts force_restart and exit:1', () => {
  const sup = [
    { event: 'force_restart' },
    { event: 'force_restart' },
    { event: 'exit', exitCode: 1 },
    { event: 'exit', exitCode: 0 },
  ];
  const out = aggregateSupervisor(sup);
  assert.equal(out.force_restart, 2);
  assert.equal(out.exit_1, 1);
});
