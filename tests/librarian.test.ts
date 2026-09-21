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

test('parse round-trips well-formed replies with no defaults', async () => {
  const reply = `<decision id="tA" action="fold">src/auth.ts: [JWT validation](hydrate://FOLD#jwt), [refresh flow](hydrate://FOLD#refresh)</decision>`;
  const { decisions, defaulted, unknown } = parseSweepReply(reply, ['tA']);
  expect(decisions.length).toBe(1);
  expect(decisions[0].action).toBe('fold');
  expect(decisions[0].stub.includes('](hydrate://FOLD#jwt)')).toBe(true);
  expect(defaulted).toEqual([]);
  expect(unknown).toEqual([]);
});

// A missing decision is NOT a failure: with N candidates the odds of the librarian
// dropping at least one grow with N, so on large sessions treating an omission as
// fatal turned a routine sweep into a probabilistic outage. The safe default is
// 'keep' — the content simply stays inline, same as if it were never picked up —
// and the id is reported via `defaulted` so callers (the sweep log) can see it happened.
test('parse defaults a missing id to keep and reports it in defaulted', async () => {
  const { decisions, defaulted } = parseSweepReply('<decision id="tB" action="keep"></decision>', ['tA', 'tB']);
  expect(decisions.length).toBe(2);
  const a = decisions.find(d => d.toolUseId === 'tA')!;
  expect(a.action).toBe('keep');
  expect(a.stub).toBe('');
  const b = decisions.find(d => d.toolUseId === 'tB')!;
  expect(b.action).toBe('keep');
  expect(defaulted).toEqual(['tA']);
});

test('parse defaults every id to keep when the reply names none of them', async () => {
  const { decisions, defaulted } = parseSweepReply('no decisions here', ['tA']);
  expect(decisions).toEqual([{ toolUseId: 'tA', action: 'keep', stub: '' }]);
  expect(defaulted).toEqual(['tA']);
});

// UNKNOWN ids are dropped, not thrown: `decisions` is built by mapping over
// expectedIds, so an id the reply names that was never offered has no path into
// `decisions` (the firewall) and can never be consulted or corrupt anything. A
// garbled transcription of a real id shows up as one unknown (the typo) plus one
// defaulted (its intended twin, now unanswered) — both reported, sweep still succeeds.
test('parse drops a reply naming an id that was never offered and reports it as unknown', async () => {
  const { decisions, defaulted, unknown } = parseSweepReply('<decision id="tX" action="keep"></decision>', ['tA']);
  expect(decisions).toEqual([{ toolUseId: 'tA', action: 'keep', stub: '' }]);
  expect(defaulted).toEqual(['tA']);
  expect(unknown).toEqual(['tX']);
});
