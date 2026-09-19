import { test, expect } from 'claude-code/testing';
import { runSweep } from '../hooks/origami';
import { readConfig } from '../hooks/origami';
import { getFold } from '../hooks/store';
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

test('sweep folds the stale result, persists the fold, logs the sweep', async () => {
  const fake = fakeEngine();
  fake.setModelComplete(() => `<decision id="t1" action="fold">Read a.ts — repeated CONTENT block.</decision>`);
  const r = await runSweep(fake.$, cfg, { trigger: 'plugin', messages: transcript() });
  if (!('messages' in r!) || !r.messages) throw new Error(`expected messages, got ${JSON.stringify(r)}`);
  // banner pair prepended: index shift +2 from the brief's original assertions
  expect(r.messages[0].text.startsWith(BANNER_PREFIX)).toBe(true);
  expect(r.messages[0].handle).toBe(undefined);
  expect(r.messages[1].text).toBe(BANNER_ACK);
  expect(r.messages[1].handle).toBe(undefined);
  expect(r.messages[4].toolResults![0].text.includes('fold-001')).toBe(true);
  const stored = await getFold(fake.io, 'fold-001');
  expect(stored!.body.includes('CONTENT')).toBe(true);
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
