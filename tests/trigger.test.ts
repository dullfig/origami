import { test, expect } from 'claude-code/testing';
import { shouldSweep, readConfig, storeIO } from '../hooks/origami';
import { putFold, putKeep } from '../hooks/store';
import { contentHash } from '../hooks/rebuild';
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

// --- F2: a raw (uncompacted) transcript view must not re-trigger a sweep for
// mass that is already folded, even though the fold's original toolUseId still
// carries its full, un-stubbed text in that raw view (observed in resumed
// headless sessions: $.session.messages() can return the pre-compaction transcript).

test('a folded (non-pinned) entry excludes its toolUseId even when messages() still shows the raw result', async () => {
  const { $ } = fakeEngine();
  const io = await storeIO($);
  const t = heavyTranscript(100000);                            // t1 is the only mass, RAW (unfolded) here
  expect((await shouldSweep($, cfg, t)).sweep).toBe(true);      // baseline: empty store still triggers
  await putFold(io, {
    id: 'fold-001', stub: 's', state: 'folded', tool: 'Read', toolUseId: 't1',
    inputKey: 'a.ts', originAge: 3, sizeTokens: 25000, hydrations: 0,
  }, 'BODY');
  // t1 already has a live 'folded' entry; its mass must be excluded regardless of
  // whether the transcript view handed to shouldSweep still shows the raw result
  expect((await shouldSweep($, cfg, t)).sweep).toBe(false);
});

// --- F11: aggressive mode must not engage on mass that is already folded ---

test('a live folds toolUseId is discounted from liveTokens, so aggressive stays false', async () => {
  const { $ } = fakeEngine();
  const io = await storeIO($);
  const t = heavyTranscript(500000);                            // ~125k tokens > 100k budget
  expect((await shouldSweep($, cfg, t)).aggressive).toBe(true); // baseline: empty store
  await putFold(io, {
    id: 'fold-001', stub: 's', state: 'folded', tool: 'Read', toolUseId: 't1',
    inputKey: 'a.ts', originAge: 3, sizeTokens: 125000, hydrations: 0,
  }, 'BODY');
  // that mass is on disk already; a raw transcript view must not push the working
  // set over budget a second time
  const d = await shouldSweep($, cfg, t);
  expect(d.aggressive).toBe(false);
  expect(d.sweep).toBe(false);
});

// --- delta sweeps: the trigger must discount keep-remembered mass ---
// Without this the trigger fires forever on mass the (non-aggressive) sweep will
// never offer — the livelock cousin of the skip-mass loop.

test('remaining unremembered mass below minFoldMass: no sweep, even though total candidate mass exceeds it', async () => {
  const { $ } = fakeEngine();
  const io = await storeIO($);
  const t = heavyTranscript(100000);                            // ~25k tokens > 20k threshold
  expect((await shouldSweep($, cfg, t)).sweep).toBe(true);      // baseline: no keep memory
  // the librarian already ruled t1 'keep' against exactly this content
  await putKeep(io, 't1', contentHash('x'.repeat(100000)));
  const d = await shouldSweep($, cfg, t);
  expect(d.sweep).toBe(false);
  expect(d.aggressive).toBe(false);
});

test('a keep entry whose hash no longer matches does NOT discount the mass', async () => {
  const { $ } = fakeEngine();
  const io = await storeIO($);
  const t = heavyTranscript(100000);
  await putKeep(io, 't1', 'a-hash-from-different-content');
  expect((await shouldSweep($, cfg, t)).sweep).toBe(true);
});

test('keep-memory never discounts liveTokens, so an over-budget session still goes aggressive', async () => {
  const { $ } = fakeEngine();
  const io = await storeIO($);
  const t = heavyTranscript(500000);                            // ~125k > 100k budget
  await putKeep(io, 't1', contentHash('x'.repeat(500000)));
  const d = await shouldSweep($, cfg, t);
  // kept content is genuinely live context: the budget pressure is real
  expect(d.aggressive).toBe(true);
  // and an aggressive sweep re-offers everything, so the mass is NOT discounted either
  expect(d.sweep).toBe(true);
});
