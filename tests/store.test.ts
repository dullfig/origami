import { test, expect } from 'claude-code/testing';
import { newFoldId, putFold, getFold, setFold, allFolds, appendLog, inputKeyOf } from '../hooks/store';
import { fakeEngine } from './fake-engine';

test('fold ids increment and zero-pad', async (_kit, on) => {
  const { $ } = fakeEngine();
  expect(await newFoldId($)).toBe('fold-001');
  expect(await newFoldId($)).toBe('fold-002');
});

test('inputKeyOf handles file_path and JSON fallback', async (_kit, on) => {
  expect(inputKeyOf({ file_path: 'test.ts' })).toBe('test.ts');
  expect(inputKeyOf({ command: 'ls' })).toBe('{"command":"ls"}');
});

test('putFold/getFold round-trips entry and body', async (_kit, on) => {
  const { $ } = fakeEngine();
  const entry = { id: 'fold-001', stub: 's', state: 'folded' as const, tool: 'Read', toolUseId: 'tA', inputKey: 'a.ts', originAge: 3, sizeTokens: 2000, hydrations: 0 };
  await putFold($, entry, '# body\ncontent');
  const got = await getFold($, 'fold-001');
  expect(got!.entry.stub).toBe('s');
  expect(got!.body).toBe('# body\ncontent');
  expect(await getFold($, 'fold-999')).toBe(undefined);
});

test('setFold updates state; allFolds lists entries', async (_kit, on) => {
  const { $ } = fakeEngine();
  const entry = { id: 'fold-001', stub: 's', state: 'folded' as const, tool: 'Read', toolUseId: 'tA', inputKey: 'a.ts', originAge: 3, sizeTokens: 2000, hydrations: 0 };
  await putFold($, entry, 'b');
  await setFold($, { ...entry, state: 'pinned', hydrations: 2 });
  const all = await allFolds($);
  expect(all.length).toBe(1);
  expect(all[0].state).toBe('pinned');
});

test('appendLog appends JSONL lines', async (_kit, on) => {
  const { $ } = fakeEngine();
  await appendLog($, { event: 'sweep', tokensBefore: 100 });
  await appendLog($, { event: 'hydrate', foldId: 'fold-001' });
  const raw = await $.fs.read('.claude/origami/origami.log');
  const lines = String(raw).trim().split('\n').map(l => JSON.parse(l));
  expect(lines.length).toBe(2);
  expect(lines[1].event).toBe('hydrate');
});
