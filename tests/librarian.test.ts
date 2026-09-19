import { test, expect } from 'claude-code/testing';
import { buildSweepPrompt, parseSweepReply } from '../hooks/librarian';
import type { Candidate } from '../hooks/rebuild';

const cand: Candidate = {
  messageIndex: 2, resultIndex: 0, toolUseId: 'tA', tool: 'Read',
  input: { file_path: 'src/auth.ts' }, text: 'FULL FILE CONTENT '.repeat(100),
  sizeTokens: 450, ageTurns: 4,
};

test('prompt carries full candidate content, never an omission note', async () => {
  const p = buildSweepPrompt([cand], false);
  expect(p.includes('FULL FILE CONTENT')).toBe(true);
  expect(p.includes('omitted')).toBe(false);
  expect(p.includes('<candidate id="tA"')).toBe(true);
});

test('aggressive mode states the budget pressure', async () => {
  expect(buildSweepPrompt([cand], true).includes('over budget')).toBe(true);
  expect(buildSweepPrompt([cand], false).includes('over budget')).toBe(false);
});

test('prompt teaches the anchor-link stub grammar', async () => {
  expect(buildSweepPrompt([cand], false).includes('hydrate://FOLD#')).toBe(true);
});

test('parse round-trips well-formed replies', async () => {
  const reply = `<decision id="tA" action="fold">src/auth.ts: [JWT validation](hydrate://FOLD#jwt), [refresh flow](hydrate://FOLD#refresh)</decision>`;
  const d = parseSweepReply(reply, ['tA']);
  expect(d.length).toBe(1);
  expect(d[0].action).toBe('fold');
  expect(d[0].stub.includes('](hydrate://FOLD#jwt)')).toBe(true);
});

test('parse throws on missing or unknown ids', async () => {
  let threw = 0;
  try { parseSweepReply('<decision id="tB" action="keep"></decision>', ['tA']); } catch { threw++; }
  try { parseSweepReply('no decisions here', ['tA']); } catch { threw++; }
  expect(threw).toBe(2);
});
