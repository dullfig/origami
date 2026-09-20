import { test, expect } from 'claude-code/testing';
import { estimateTokens, turnAges, selectCandidates, candidateMass, sweepMarkerPair } from '../hooks/rebuild';
import { readConfig } from '../hooks/origami';
import type { SessionMessage } from 'claude-code';

const cfg = readConfig(undefined);

function msg(m: Partial<SessionMessage> & Pick<SessionMessage, 'role'>): SessionMessage {
  return { text: '', toolUses: [], ...m } as SessionMessage;
}
function bigResult(id: string, chars = 8000) {
  return { tool_use_id: id, text: 'x'.repeat(chars), isError: false };
}
// 5 turns: t0..t4 (t4 newest). Turn 1 holds a big Read result.
function transcript(): SessionMessage[] {
  const out: SessionMessage[] = [msg({ role: 'user', text: 'turn0 prompt' }), msg({ role: 'assistant', text: 'reply0' })];
  out.push(msg({ role: 'user', text: 'turn1 prompt' }));
  out.push(msg({ role: 'assistant', toolUses: [{ tool_use_id: 't1', tool: 'Read', input: { file_path: 'a.ts' } }] }));
  out.push(msg({ role: 'user', toolResults: [bigResult('t1')] }));
  out.push(msg({ role: 'assistant', text: 'reply1' }));
  for (let i = 2; i <= 4; i++) {
    out.push(msg({ role: 'user', text: `turn${i} prompt` }), msg({ role: 'assistant', text: `reply${i}` }));
  }
  return out;
}

test('estimateTokens ~ chars/4', async () => {
  expect(estimateTokens('x'.repeat(4000))).toBe(1000);
});

test('turnAges: tool-result-only user message stays in its turn', async () => {
  const ages = turnAges(transcript());
  expect(ages[0]).toBe(4);            // turn0 under 5 turns total
  expect(ages[4]).toBe(3);            // the t1 result row belongs to turn1
  expect(ages[ages.length - 1]).toBe(0);
});

test('selectCandidates: old big result is a candidate; young and excluded are not', async () => {
  const t = transcript();
  const c1 = selectCandidates(t, new Set(), cfg, false);
  expect(c1.length).toBe(1);
  expect(c1[0].toolUseId).toBe('t1');
  expect(c1[0].ageTurns).toBe(3);
  expect(candidateMass(c1)).toBe(estimateTokens('x'.repeat(8000)));
  // excluded (already folded or pinned) never reappears
  expect(selectCandidates(t, new Set(['t1']), cfg, false).length).toBe(0);
});

test('selectCandidates: aggressive treats foldAgeTurns as 1', async () => {
  const t = transcript();
  // add a result in turn 4 (age 0) and one in turn 3 (age 1)
  t.push(msg({ role: 'assistant', toolUses: [{ tool_use_id: 't9', tool: 'Bash', input: { command: 'ls' } }] }));
  t.push(msg({ role: 'user', toolResults: [bigResult('t9')] }));
  const normal = selectCandidates(t, new Set(), cfg, false);
  expect(normal.some(c => c.toolUseId === 't9')).toBe(false); // age 0 < 3
  const agg = selectCandidates(t, new Set(), cfg, true);
  expect(agg.some(c => c.toolUseId === 't9')).toBe(false);    // age 0 < 1 still protects the live turn
});

test('small results are never candidates', async () => {
  const t = transcript();
  t[4] = msg({ role: 'user', toolResults: [{ tool_use_id: 't1', text: 'ok', isError: false }] });
  expect(selectCandidates(t, new Set(), cfg, false).length).toBe(0);
});

// v1.1 item 6, decision 6: markers/acks carry no toolResults, so they can never be
// folded — selectCandidates ignores them by construction (it only scans toolResults),
// and their small text does not disturb the mass accounting elsewhere.
test('a sweep marker pair yields no fold candidate, old as it may become', async () => {
  const t = transcript();
  const marker = sweepMarkerPair({ foldedIds: ['fold-001'], restoredIds: [], activeFolds: 1 });
  const withMarker = [...t, ...marker, msg({ role: 'user', text: 'turn5 prompt' }), msg({ role: 'assistant', text: 'reply5' })];
  const before = selectCandidates(t, new Set(), cfg, false);
  const after = selectCandidates(withMarker, new Set(), cfg, false);
  // the real candidate (t1) is still found, unaffected by the marker's presence
  expect(after.map(c => c.toolUseId)).toEqual(before.map(c => c.toolUseId));
  // and no candidate is ever produced for the marker's own two messages
  expect(after.some(c => c.text.startsWith('[origami sweep report:'))).toBe(false);
});
