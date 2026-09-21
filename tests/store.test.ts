import { test, expect } from 'claude-code/testing';
import { newFoldId, putFold, getFold, setFold, allFolds, appendLog, inputKeyOf, getKeeps, putKeep, dropKeep } from '../hooks/store';
import { contentHash } from '../hooks/rebuild';
import { fakeEngine } from './fake-engine';

test('fold ids increment and zero-pad', async (_kit, on) => {
  const { io } = fakeEngine();
  expect(await newFoldId(io)).toBe('fold-001');
  expect(await newFoldId(io)).toBe('fold-002');
});

test('inputKeyOf handles file_path and JSON fallback', async (_kit, on) => {
  expect(inputKeyOf({ file_path: 'test.ts' })).toBe('test.ts');
  expect(inputKeyOf({ command: 'ls' })).toBe('{"command":"ls"}');
});

test('putFold/getFold round-trips entry and body', async (_kit, on) => {
  const { io } = fakeEngine();
  const entry = { id: 'fold-001', stub: 's', state: 'folded' as const, tool: 'Read', toolUseId: 'tA', inputKey: 'a.ts', originAge: 3, sizeTokens: 2000, hydrations: 0 };
  await putFold(io, entry, '# body\ncontent');
  const got = await getFold(io, 'fold-001');
  expect(got!.entry.stub).toBe('s');
  expect(got!.body).toBe('# body\ncontent');
  expect(await getFold(io, 'fold-999')).toBe(undefined);
});

test('setFold updates state; allFolds lists entries', async (_kit, on) => {
  const { io } = fakeEngine();
  const entry = { id: 'fold-001', stub: 's', state: 'folded' as const, tool: 'Read', toolUseId: 'tA', inputKey: 'a.ts', originAge: 3, sizeTokens: 2000, hydrations: 0 };
  await putFold(io, entry, 'b');
  await setFold(io, { ...entry, state: 'pinned', hydrations: 2 });
  const all = await allFolds(io);
  expect(all.length).toBe(1);
  expect(all[0].state).toBe('pinned');
});

test('appendLog appends JSONL lines', async (_kit, on) => {
  const { io } = fakeEngine();
  await appendLog(io, { event: 'sweep', tokensBefore: 100 });
  await appendLog(io, { event: 'hydrate', foldId: 'fold-001' });
  const raw = await io.fsRead('.claude/origami/origami.log');
  const lines = String(raw).trim().split('\n').map(l => JSON.parse(l));
  expect(lines.length).toBe(2);
  expect(lines[1].event).toBe('hydrate');
});

// --- keep-memory (delta sweeps) ---

test('keep-memory round-trips: put, get, drop', async (_kit, on) => {
  const { io } = fakeEngine();
  expect((await getKeeps(io)).size).toBe(0);
  await putKeep(io, 'tA', 'hash-a');
  await putKeep(io, 'tB', 'hash-b');
  const keeps = await getKeeps(io);
  expect(keeps.size).toBe(2);
  expect(keeps.get('tA')!.hash).toBe('hash-a');
  expect(typeof keeps.get('tA')!.ts).toBe('string');
  expect(keeps.get('tB')!.hash).toBe('hash-b');
  await dropKeep(io, 'tA');
  const after = await getKeeps(io);
  expect(after.size).toBe(1);
  expect(after.has('tA')).toBe(false);
  expect(after.get('tB')!.hash).toBe('hash-b');
  // dropping an id that was never remembered is a no-op, never a throw
  await dropKeep(io, 'tNever');
  expect((await getKeeps(io)).size).toBe(1);
});

test('keep keys do not collide with fold keys in either direction', async (_kit, on) => {
  const { io } = fakeEngine();
  await putFold(io, {
    id: 'fold-001', stub: 's', state: 'folded', tool: 'Read', toolUseId: 'tA',
    inputKey: 'a.ts', originAge: 3, sizeTokens: 2000, hydrations: 0,
  }, 'b');
  await putKeep(io, 'tA', contentHash('some text'));
  expect((await allFolds(io)).length).toBe(1);
  expect((await getKeeps(io)).size).toBe(1);
  await dropKeep(io, 'tA');
  expect((await allFolds(io)).length).toBe(1);   // the fold entry is untouched
  expect((await getKeeps(io)).size).toBe(0);
});

test('contentHash is stable, length-sensitive, and distinguishes different text', async (_kit, on) => {
  expect(contentHash('abc')).toBe(contentHash('abc'));
  expect(contentHash('abc') === contentHash('abd')).toBe(false);
  expect(contentHash('') === contentHash('a')).toBe(false);
  expect(contentHash('x'.repeat(1000)) === contentHash('x'.repeat(1001))).toBe(false);
});
