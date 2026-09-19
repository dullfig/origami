import { test, expect } from 'claude-code/testing';
import { shouldSweep, readConfig, storeIO } from '../hooks/origami';
import { putFold } from '../hooks/store';
import { fakeEngine } from './fake-engine';
import type { SessionMessage } from 'claude-code';

const cfg = readConfig(undefined);

function heavyTranscript(resultChars: number): SessionMessage[] {
  const out: SessionMessage[] = [{ role: 'user', text: 'turn0', toolUses: [] }];
  out.push({ role: 'assistant', text: '', toolUses: [{ tool_use_id: 't1', tool: 'Read', input: {} }] });
  out.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: 'x'.repeat(resultChars), isError: false }] });
  for (let i = 1; i <= 4; i++) {
    out.push({ role: 'user', text: `turn${i}`, toolUses: [] });
    out.push({ role: 'assistant', text: `r${i}`, toolUses: [] });
  }
  return out;
}

test('mass below threshold: no sweep', async () => {
  const { $ } = fakeEngine();
  const d = await shouldSweep($, cfg, heavyTranscript(8000));   // ~2k tokens < 20k
  expect(d.sweep).toBe(false);
});

test('mass above threshold: sweep', async () => {
  const { $ } = fakeEngine();
  const d = await shouldSweep($, cfg, heavyTranscript(100000)); // ~25k tokens
  expect(d.sweep).toBe(true);
  expect(d.aggressive).toBe(false);
});

test('working set over budget: aggressive', async () => {
  const { $ } = fakeEngine();
  const d = await shouldSweep($, cfg, heavyTranscript(500000)); // ~125k > 100k budget
  expect(d.aggressive).toBe(true);
});

// --- finding 1: a skipped sweep must not re-fire on identical mass forever ---

test('after a skip the trigger stays quiet until the mass meaningfully grows', async () => {
  const { $ } = fakeEngine();
  const io = await storeIO($);
  const t = heavyTranscript(100000);                            // ~25k tokens of foldable mass
  expect((await shouldSweep($, cfg, t)).sweep).toBe(true);
  await io.storeSet('origami:lastSkipMass', 25000);             // what a skipped sweep records
  expect((await shouldSweep($, cfg, t)).sweep).toBe(false);     // identical mass: no livelock
  // slightly more mass is still inside the cooldown band
  expect((await shouldSweep($, cfg, heavyTranscript(110000))).sweep).toBe(false);
  // meaningfully more (> 1.2x) re-arms the trigger
  expect((await shouldSweep($, cfg, heavyTranscript(140000))).sweep).toBe(true);
  // and a successful sweep clears the marker
  await io.storeSet('origami:lastSkipMass', 0);
  expect((await shouldSweep($, cfg, t)).sweep).toBe(true);
});

// --- finding 5: the trigger must apply runSweep's pinned exclusion ---

test('a pinned fold restored inline does not re-trigger the sweep', async () => {
  const { $ } = fakeEngine();
  const io = await storeIO($);
  const t = heavyTranscript(100000);                            // t1 is the only mass
  expect((await shouldSweep($, cfg, t)).sweep).toBe(true);
  await putFold(io, {
    id: 'fold-001', stub: 's', state: 'pinned', tool: 'Read', toolUseId: 't1',
    inputKey: 'a.ts', originAge: 3, sizeTokens: 25000, hydrations: 2,
  }, 'BODY');
  // runSweep would exclude t1 and find nothing to fold; the trigger must agree
  expect((await shouldSweep($, cfg, t)).sweep).toBe(false);
});
