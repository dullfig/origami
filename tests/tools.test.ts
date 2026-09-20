import { test, expect } from 'claude-code/testing';
import { handleHydrate, handleUnpin, observeMissedHydrate, readConfig, storeIO } from '../hooks/origami';
import { putFold, getFold, allFolds, newFoldId } from '../hooks/store';
import { fakeEngine } from './fake-engine';

const cfg = readConfig(undefined);
const entry = { id: 'fold-001', stub: 's', state: 'folded' as const, tool: 'Read', toolUseId: 'tA', inputKey: 'a.ts', originAge: 3, sizeTokens: 2000, hydrations: 0 };

test('hydrate returns body, counts, pins at threshold, logs', async (_kit, on) => {
  const { $ } = fakeEngine();
  const io = await storeIO($);
  await putFold(io, entry, 'THE FULL BODY');
  const first = await handleHydrate($, cfg, 'fold-001');
  expect(first.includes('THE FULL BODY')).toBe(true);
  expect((await getFold(io, 'fold-001'))!.entry.hydrations).toBe(1);
  const second = await handleHydrate($, cfg, 'fold-001');
  expect(second.includes('pinned')).toBe(true);               // tells the model it is now pinned
  // F9: the notice rides at BOTH ends, so a head-truncated preview still carries it
  expect(second.startsWith('[origami: fold-001')).toBe(true);
  expect(second.indexOf('pinned') < second.indexOf('THE FULL BODY')).toBe(true);
  expect(second.lastIndexOf('pinned') > second.indexOf('THE FULL BODY')).toBe(true);
  expect((await getFold(io, 'fold-001'))!.entry.state).toBe('pinned');
  const log = String(await $.fs.read('.claude/origami/origami.log'));
  expect(log.split('\n').filter(l => l.includes('"event":"hydrate"')).length).toBe(2);
});

test('unpin resets state and count, logs', async (_kit, on) => {
  const { $ } = fakeEngine();
  const io = await storeIO($);
  await putFold(io, { ...entry, state: 'pinned', hydrations: 2 }, 'B');
  const r = await handleUnpin($, 'fold-001');
  expect(r.includes('fold-001')).toBe(true);
  const got = (await getFold(io, 'fold-001'))!.entry;
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
  const io = await storeIO($);
  await putFold(io, entry, 'B');
  await handleHydrate($, cfg, 'fold-001', 'refresh');
  const log = String(await $.fs.read('.claude/origami/origami.log'));
  expect(log.includes('"anchor":"refresh"')).toBe(true);
});

test('a Read matching a live fold logs missed_hydrate; pinned and non-matching do not', async (_kit, on) => {
  const { $ } = fakeEngine();
  const io = await storeIO($);
  await putFold(io, entry, 'B');                                     // inputKey 'a.ts', state folded
  await observeMissedHydrate($, { tool: 'Read', input: { file_path: 'a.ts' } });
  await observeMissedHydrate($, { tool: 'Read', input: { file_path: 'other.ts' } });
  const log1 = String(await $.fs.read('.claude/origami/origami.log'));
  expect(log1.split('\n').filter(l => l.includes('"event":"missed_hydrate"')).length).toBe(1);
  await putFold(io, { ...entry, id: 'fold-002', state: 'pinned', inputKey: 'b.ts' }, 'B');
  await observeMissedHydrate($, { tool: 'Read', input: { file_path: 'b.ts' } });   // pinned = content inline, re-read is fine
  const log2 = String(await $.fs.read('.claude/origami/origami.log'));
  expect(log2.split('\n').filter(l => l.includes('"event":"missed_hydrate"')).length).toBe(1);
});

// --- finding 3: a tool.call hook must ANSWER, never throw ---

test('hydrate on an entry whose body file vanished answers instructively, never throws', async (_kit, on) => {
  const { $, files } = fakeEngine();
  const io = await storeIO($);
  await putFold(io, entry, 'THE FULL BODY');
  for (const k of [...files.keys()]) if (k.includes('/folds/')) files.delete(k);   // body gone, index entry stays
  const h = await handleHydrate($, cfg, 'fold-001');
  expect(h.includes('fold-001')).toBe(true);
  expect(h.toLowerCase().includes('could not hydrate')).toBe(true);
});

test('a failing log write never takes down hydrate or unpin', async (_kit, on) => {
  const { $, failWritesWhen } = fakeEngine();
  const io = await storeIO($);
  await putFold(io, { ...entry, state: 'pinned', hydrations: 2 }, 'THE FULL BODY');
  failWritesWhen(p => p.endsWith('origami.log'));                                  // the 4 MiB fs ceiling, in effect
  const h = await handleHydrate($, cfg, 'fold-001');
  expect(h.includes('THE FULL BODY')).toBe(true);
  const u = await handleUnpin($, 'fold-001');
  expect(u.includes('unpinned')).toBe(true);
  expect((await getFold(io, 'fold-001'))!.entry.state).toBe('folded');             // the real work still landed
});

// --- finding 4: $.store is plugin-global, so keys must be project-scoped ---

test('the fold index does not leak between projects sharing the plugin-global store', async (_kit, on) => {
  const a = fakeEngine('/proj/alpha');
  // a second session in a different project, over the SAME plugin-global store
  const b = { ...(a.$ as unknown as Record<string, unknown>), session: { root: async () => '/proj/beta' } } as unknown as typeof a.$;
  const ioA = await storeIO(a.$);
  const ioB = await storeIO(b);
  await putFold(ioA, entry, 'ALPHA BODY');
  expect((await allFolds(ioA)).length).toBe(1);
  expect((await allFolds(ioB)).length).toBe(0);            // no leak: beta sees none of alpha's
  await putFold(ioB, { ...entry, inputKey: 'b.ts' }, 'BETA BODY');
  expect((await allFolds(ioA)).length).toBe(1);            // and the namespaces coexist
  expect((await allFolds(ioB)).length).toBe(1);
  expect((await allFolds(ioB))[0].inputKey).toBe('b.ts');
  expect(a.kv.size).toBe(2);                               // two entries, two distinct keys
  // the seq counter is per-project too
  expect(await newFoldId(ioA)).toBe('fold-001');
  expect(await newFoldId(ioB)).toBe('fold-001');
});

// --- finding 7: restores are byte-exact; the header never nests ---

test('the header rides in its own slot; the body round-trips byte-exact', async (_kit, on) => {
  const { $ } = fakeEngine();
  const io = await storeIO($);
  const original = '# not a header\n\nline1\nline2\n';
  const header = '# fold-001 · Read {"file_path":"a.ts"}';
  await putFold(io, entry, original, header);
  const got = await getFold(io, 'fold-001');
  expect(got!.body).toBe(original);                        // byte-exact, header stripped off
  expect(got!.header).toBe(header);
  // refolding the restored body cannot nest a second header
  await putFold(io, entry, got!.body, header);
  expect((await getFold(io, 'fold-001'))!.body).toBe(original);
});
