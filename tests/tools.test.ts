import { test, expect } from 'claude-code/testing';
import { handleHydrate, handleUnpin, observeMissedHydrate, readConfig } from '../hooks/origami';
import { putFold, getFold } from '../hooks/store';
import { fakeEngine } from './fake-engine';

const cfg = readConfig(undefined);
const entry = { id: 'fold-001', stub: 's', state: 'folded' as const, tool: 'Read', toolUseId: 'tA', inputKey: 'a.ts', originAge: 3, sizeTokens: 2000, hydrations: 0 };

test('hydrate returns body, counts, pins at threshold, logs', async (_kit, on) => {
  const { $ } = fakeEngine();
  await putFold($, entry, 'THE FULL BODY');
  const first = await handleHydrate($, cfg, 'fold-001');
  expect(first.includes('THE FULL BODY')).toBe(true);
  expect((await getFold($, 'fold-001'))!.entry.hydrations).toBe(1);
  const second = await handleHydrate($, cfg, 'fold-001');
  expect(second.includes('pinned')).toBe(true);               // tells the model it is now pinned
  expect((await getFold($, 'fold-001'))!.entry.state).toBe('pinned');
  const log = String(await $.fs.read('.claude/origami/origami.log'));
  expect(log.split('\n').filter(l => l.includes('"event":"hydrate"')).length).toBe(2);
});

test('unpin resets state and count, logs', async (_kit, on) => {
  const { $ } = fakeEngine();
  await putFold($, { ...entry, state: 'pinned', hydrations: 2 }, 'B');
  const r = await handleUnpin($, 'fold-001');
  expect(r.includes('fold-001')).toBe(true);
  const got = (await getFold($, 'fold-001'))!.entry;
  expect(got.state).toBe('folded');
  expect(got.hydrations).toBe(0);
});

test('unknown ids return instructive errors, never throw', async (_kit, on) => {
  const { $ } = fakeEngine();
  const h = await handleHydrate($, cfg, 'fold-999');
  expect(h.includes('fold-999')).toBe(true);
  expect(h.toLowerCase().includes('unknown')).toBe(true);
  const u = await handleUnpin($, 'nonsense');
  expect(u.toLowerCase().includes('unknown')).toBe(true);
});

test('hydrate logs the motivating anchor when given', async (_kit, on) => {
  const { $ } = fakeEngine();
  await putFold($, entry, 'B');
  await handleHydrate($, cfg, 'fold-001', 'refresh');
  const log = String(await $.fs.read('.claude/origami/origami.log'));
  expect(log.includes('"anchor":"refresh"')).toBe(true);
});

test('a Read matching a live fold logs missed_hydrate; pinned and non-matching do not', async (_kit, on) => {
  const { $ } = fakeEngine();
  await putFold($, entry, 'B');                                     // inputKey 'a.ts', state folded
  await observeMissedHydrate($, { tool: 'Read', input: { file_path: 'a.ts' } });
  await observeMissedHydrate($, { tool: 'Read', input: { file_path: 'other.ts' } });
  const log1 = String(await $.fs.read('.claude/origami/origami.log'));
  expect(log1.split('\n').filter(l => l.includes('"event":"missed_hydrate"')).length).toBe(1);
  await putFold($, { ...entry, id: 'fold-002', state: 'pinned', inputKey: 'b.ts' }, 'B');
  await observeMissedHydrate($, { tool: 'Read', input: { file_path: 'b.ts' } });   // pinned = content inline, re-read is fine
  const log2 = String(await $.fs.read('.claude/origami/origami.log'));
  expect(log2.split('\n').filter(l => l.includes('"event":"missed_hydrate"')).length).toBe(1);
});
