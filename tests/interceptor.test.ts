import { test, expect } from 'claude-code/testing';
import { runSweep, storeIO, handleHydrate, observeMissedHydrate } from '../hooks/origami';
import { readConfig } from '../hooks/origami';
import { getFold, allFolds, putFold } from '../hooks/store';
import { BANNER_PREFIX, BANNER_ACK } from '../hooks/rebuild';
import { fakeEngine } from './fake-engine';
import type { SessionMessage } from 'claude-code';

const cfg = readConfig(undefined);

function transcript(): SessionMessage[] {
  const out: SessionMessage[] = [{ role: 'user', text: 'turn0', toolUses: [], handle: 'h0' }];
  out.push({ role: 'assistant', text: '', toolUses: [{ tool_use_id: 't1', tool: 'Read', input: { file_path: 'a.ts' } }], handle: 'h1' });
  out.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: 'CONTENT '.repeat(2000), isError: false }], handle: 'h2' });
  for (let i = 1; i <= 4; i++) {
    out.push({ role: 'user', text: `turn${i}`, toolUses: [], handle: `hu${i}` });
    out.push({ role: 'assistant', text: `r${i}`, toolUses: [], handle: `ha${i}` });
  }
  return out;
}

// answers every candidate the prompt names with a fold decision
function foldEverything(req: { prompt: string }): string {
  return [...req.prompt.matchAll(/<candidate id="([^"]+)"/g)]
    .map(m => `<decision id="${m[1]}" action="fold">folded ${m[1]}.</decision>`).join('\n');
}

test('sweep folds the stale result, persists the fold, logs the sweep', async () => {
  const fake = fakeEngine();
  const io = await storeIO(fake.$);
  fake.setModelComplete(() => `<decision id="t1" action="fold">Read a.ts — repeated CONTENT block.</decision>`);
  const r = await runSweep(fake.$, cfg, { trigger: 'plugin', messages: transcript() });
  if (!('messages' in r!) || !r.messages) throw new Error(`expected messages, got ${JSON.stringify(r)}`);
  // banner pair prepended: index shift +2 from the brief's original assertions
  expect(r.messages[0].text.startsWith(BANNER_PREFIX)).toBe(true);
  expect(r.messages[0].handle).toBe(undefined);
  expect(r.messages[1].text).toBe(BANNER_ACK);
  expect(r.messages[1].handle).toBe(undefined);
  expect(r.messages[4].toolResults![0].text.includes('fold-001')).toBe(true);
  const stored = await getFold(io, 'fold-001');
  expect(stored!.body).toBe('CONTENT '.repeat(2000));   // byte-exact: the header is not in the body
  expect(stored!.header!.includes('fold-001 · Read')).toBe(true);
  const log = String(await fake.$.fs.read('.claude/origami/origami.log'));
  expect(log.includes('"event":"sweep"')).toBe(true);
  expect(log.includes('librarianInputTokens')).toBe(true);
});

test('subagent compaction passes through untouched', async () => {
  const fake = fakeEngine();
  const r = await runSweep(fake.$, cfg, { trigger: 'plugin', agentId: 'sub-1', messages: transcript() });
  expect(r).toBe(undefined); // undefined = caller must next(e)
});

test('librarian failure on plugin trigger yields skip; on manual yields pass-through', async () => {
  const fake = fakeEngine();
  fake.setModelComplete(() => { throw new Error('model down'); });
  const plugin = await runSweep(fake.$, cfg, { trigger: 'plugin', messages: transcript() });
  expect((plugin as { skip?: string })?.skip !== undefined).toBe(true);
  const manual = await runSweep(fake.$, cfg, { trigger: 'manual', messages: transcript() });
  expect(manual).toBe(undefined); // fall through to built-in compaction
});

// --- finding 8(a): a second sweep over the first sweep's own output ---

test('two sweeps: banner re-applied exactly once, existing stubs are not re-folded', async () => {
  const fake = fakeEngine();
  const io = await storeIO(fake.$);
  fake.setModelComplete(foldEverything);

  const first = await runSweep(fake.$, cfg, { trigger: 'plugin', messages: transcript() });
  if (!('messages' in first!) || !first.messages) throw new Error('expected a rebuilt first sweep');
  expect((await allFolds(io)).map(f => f.id)).toEqual(['fold-001']);

  // the conversation continues on top of the swept transcript: a new big result lands
  // and ages out of the protected window
  const second: SessionMessage[] = [...first.messages];
  second.push({ role: 'user', text: 'turn5', toolUses: [], handle: 'hu5' });
  second.push({ role: 'assistant', text: '', toolUses: [{ tool_use_id: 't2', tool: 'Read', input: { file_path: 'b.ts' } }], handle: 'h20' });
  second.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't2', text: 'OTHER '.repeat(3000), isError: false }], handle: 'h21' });
  for (let i = 6; i <= 8; i++) {
    second.push({ role: 'user', text: `turn${i}`, toolUses: [], handle: `hu${i}` });
    second.push({ role: 'assistant', text: `r${i}`, toolUses: [], handle: `ha${i}` });
  }

  const r = await runSweep(fake.$, cfg, { trigger: 'plugin', messages: second });
  if (!('messages' in r!) || !r.messages) throw new Error(`expected a rebuilt second sweep, got ${JSON.stringify(r)}`);
  // exactly one banner, at the top, carrying the new count
  const banners = r.messages.filter(m => m.role === 'user' && m.text.startsWith(BANNER_PREFIX));
  expect(banners.length).toBe(1);
  expect(r.messages[0].text.startsWith(BANNER_PREFIX)).toBe(true);
  expect(r.messages[1].text).toBe(BANNER_ACK);
  expect(r.messages[0].text).toContain('Currently 2 folds active.');
  // the first sweep's stub is carried through untouched, never re-folded
  const stubs = r.messages.flatMap(m => m.toolResults ?? []).filter(x => x.text.startsWith('[origami '));
  expect(stubs.length).toBe(2);
  expect(stubs.filter(s => s.text.includes('fold-001')).length).toBe(1);
  expect(stubs.filter(s => s.text.includes('fold-002')).length).toBe(1);
  // exactly two folds exist, both still live
  const folds = await allFolds(io);
  expect(folds.map(f => f.id).sort()).toEqual(['fold-001', 'fold-002']);
  expect(folds.every(f => f.state === 'folded')).toBe(true);
  expect((await getFold(io, 'fold-002'))!.body).toBe('OTHER '.repeat(3000));
});

// --- finding 6: fold-entry lifecycle ---

test('a folded entry whose stub has vanished is evicted, not counted, not matched', async () => {
  const fake = fakeEngine();
  const io = await storeIO(fake.$);
  fake.setModelComplete(foldEverything);
  // a dead entry: unpinned-then-refolded under a new id, or its stub edited away
  await putFold(io, {
    id: 'fold-000', stub: 's', state: 'folded', tool: 'Read', toolUseId: 'tGone',
    inputKey: 'gone.ts', originAge: 5, sizeTokens: 4000, hydrations: 0,
  }, 'ORPHANED BODY');

  const r = await runSweep(fake.$, cfg, { trigger: 'plugin', messages: transcript() });
  if (!('messages' in r!) || !r.messages) throw new Error('expected a rebuilt sweep');
  const dead = (await allFolds(io)).find(f => f.id === 'fold-000')!;
  expect(dead.state).toBe('evicted');
  expect(r.messages[0].text).toContain('Currently 1 folds active.');   // only the live fold counts
  // the observer no longer reports a re-read of it as a missed hydrate
  await observeMissedHydrate(fake.$, { tool: 'Read', input: { file_path: 'gone.ts' } });
  const log = String(await fake.$.fs.read('.claude/origami/origami.log'));
  expect(log.includes('"event":"missed_hydrate"')).toBe(false);
  // hydrate still serves the stored body, and says the fold is evicted
  const h = await handleHydrate(fake.$, cfg, 'fold-000');
  expect(h.includes('ORPHANED BODY')).toBe(true);
  expect(h.includes('evicted')).toBe(true);
});

// --- finding 8(b): an insufficient outcome must persist NOTHING and arm the cooldown ---

test('insufficient reduction through runSweep persists no folds and records the skip mass', async () => {
  const fake = fakeEngine();
  const io = await storeIO(fake.$);
  fake.setModelComplete(foldEverything);
  // a modest foldable result inside a transcript whose mass folding cannot touch:
  // the reduction lands far below minReductionRatio
  const t = transcript();
  t[2] = { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: 'x'.repeat(1200), isError: false }], handle: 'h2' };
  t.splice(3, 0, { role: 'assistant', text: 'y'.repeat(400000), toolUses: [], handle: 'hbig' });

  const r = await runSweep(fake.$, cfg, { trigger: 'plugin', messages: t });
  expect((r as { skip?: string }).skip!.includes('below threshold')).toBe(true);
  // nothing persisted: no index entries, no body files
  expect((await allFolds(io)).length).toBe(0);
  expect([...fake.files.keys()].filter(k => k.includes('/folds/')).length).toBe(0);
  // and the cooldown marker is armed with the mass we skipped on
  expect(await io.storeGet('origami:lastSkipMass')).toBe(300);   // 1200 chars / 4
});
