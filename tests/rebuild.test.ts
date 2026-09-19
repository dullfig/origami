import { test, expect } from 'claude-code/testing';
import {
  rebuild, stubText, estimateTokens,
  bannerText, stripBanner, applyBanner, BANNER_PREFIX, BANNER_ACK,
} from '../hooks/rebuild';
import { readConfig } from '../hooks/origami';
import type { SessionMessage } from 'claude-code';

const cfg = readConfig(undefined);

function transcript(): SessionMessage[] {
  return [
    { role: 'user', text: 'turn0', toolUses: [], handle: 'h0' },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 't1', tool: 'Read', input: { file_path: 'a.ts' } }], handle: 'h1' },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: 'x'.repeat(8000), isError: false }], handle: 'h2' },
    { role: 'assistant', text: 'done reading', toolUses: [], handle: 'h3' },
    { role: 'user', text: 'turn1', toolUses: [], handle: 'h4' },
    { role: 'assistant', text: 'r1', toolUses: [], handle: 'h5' },
    { role: 'user', text: 'turn2', toolUses: [], handle: 'h6' },
    { role: 'assistant', text: 'r2', toolUses: [], handle: 'h7' },
    { role: 'user', text: 'turn3', toolUses: [], handle: 'h8' },
    { role: 'assistant', text: 'r3', toolUses: [], handle: 'h9' },
  ];
}
const fold = { toolUseId: 't1', foldId: 'fold-001', stub: 'Read a.ts — the alpha module, defines X.' };

test('folded result becomes stub; untouched messages keep handles; text verbatim', async () => {
  const r = rebuild(transcript(), [fold], [], cfg);
  if (r.kind !== 'rebuilt') throw new Error('expected rebuilt');
  const folded = r.messages[2];
  expect(folded.handle).toBe(undefined);                       // rebuilt message drops its handle
  expect(folded.toolResults![0].text).toBe(stubText('fold-001', 'Read', fold.stub));
  expect(folded.toolResults![0].tool_use_id).toBe('t1');       // pair intact
  expect(r.messages[1].handle).toBe('h1');                     // neighbor untouched
  expect(r.messages[3].text).toBe('done reading');             // assistant text verbatim
  expect(r.messages.length).toBe(10);                          // nothing dropped
  expect(r.tokensAfter).toBeLessThan(r.tokensBefore);
});

test('restore puts pinned body back inline', async () => {
  const t = transcript();
  t[2] = { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: stubText('fold-001', 'Read', 'stub'), isError: false }], handle: 'h2' };
  const r = rebuild(t, [], [{ toolUseId: 't1', foldId: 'fold-001', body: 'FULL BODY '.repeat(400) }], cfg);
  if (r.kind !== 'rebuilt') throw new Error('expected rebuilt');
  expect(r.messages[2].toolResults![0].text).toBe('FULL BODY '.repeat(400));
});

test('messages in the newest preserveRecentTurns turns are never rebuilt', async () => {
  // fold targets t1 which lives in turn0 of a 4-turn transcript: allowed.
  // A decision naming a result inside the recent window must be refused loudly.
  const t = transcript();
  t.push({ role: 'assistant', text: '', toolUses: [{ tool_use_id: 't9', tool: 'Bash', input: {} }], handle: 'h10' });
  t.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't9', text: 'y'.repeat(8000), isError: false }], handle: 'h11' });
  let threw = false;
  try { rebuild(t, [{ toolUseId: 't9', foldId: 'fold-002', stub: 's' }], [], cfg); } catch { threw = true; }
  expect(threw).toBe(true);
});

test('insufficient reduction reports instead of rebuilding', async () => {
  const t = transcript();
  // Fix for brief defect (controller amendment 1): a 1200-char foldable result in an
  // otherwise tiny transcript folds down to ~84% reduction, which is ABOVE
  // minReductionRatio (0.15) and would spuriously report 'rebuilt'. To genuinely
  // exercise the insufficient-reduction path, give the transcript large mass that
  // folding does NOT touch: message index 3 ('done reading', an untouched, unprotected
  // assistant text — age 3, not inside the preserveRecentTurns=3 window, and never a
  // fold/restore target) is enlarged to 'y'.repeat(40000) (~10000 tokens).
  // Mass: tokensBefore ~= 2(turn0) + 5(t1 input json) + 300(1200-char result) +
  // 10000(enlarged text) + 2+1+2+1+2+1 (turn1..turn3 text) = ~10316.
  // Folding removes the 300-token result and adds a short stub (~35 tokens):
  // savings ~= 265 tokens of ~10316 total ~= 0.026, well below 0.15 -> 'insufficient'.
  t[2] = { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: 'x'.repeat(1200), isError: false }], handle: 'h2' };
  t[3] = { role: 'assistant', text: 'y'.repeat(40000), toolUses: [], handle: 'h3' };
  const r = rebuild(t, [fold], [], cfg);
  expect(r.kind).toBe('insufficient');
});

// --- Banner (controller amendment 2) ---

test('bannerText contains required elements and starts with BANNER_PREFIX', async () => {
  const b = bannerText('1.0', 3);
  expect(b.startsWith(BANNER_PREFIX)).toBe(true);
  expect(b).toContain('ORIGAMI v1.0');
  expect(b).toContain('Currently 3 folds active.');
  expect(b).toContain('hydrate');
  expect(b).toContain('BETA DUTY');
});

test('applyBanner prepends a handle-less user+assistant pair', async () => {
  const t = transcript();
  const banner = bannerText('1.0', 1);
  const withBanner = applyBanner(t, banner);
  expect(withBanner.length).toBe(t.length + 2);
  expect(withBanner[0].role).toBe('user');
  expect(withBanner[0].text.startsWith(BANNER_PREFIX)).toBe(true);
  expect(withBanner[0].handle).toBe(undefined);
  expect(withBanner[1].role).toBe('assistant');
  expect(withBanner[1].text).toBe(BANNER_ACK);
  expect(withBanner[1].handle).toBe(undefined);
  expect(withBanner[2].handle).toBe(t[0].handle);
});

test('stripBanner is the inverse of applyBanner, and a no-op without a banner', async () => {
  const t = transcript();
  const bannered = applyBanner(t, bannerText('1.0', 1));
  const stripped = stripBanner(bannered);
  expect(stripped.length).toBe(t.length);
  expect(stripped.map(m => m.handle)).toEqual(t.map(m => m.handle));

  const noBanner = stripBanner(t);
  expect(noBanner.length).toBe(t.length);
  expect(noBanner.map(m => m.handle)).toEqual(t.map(m => m.handle));
});

test('re-banner round trip updates the fold count with exactly one banner', async () => {
  const t = transcript();
  const bannered = applyBanner(t, bannerText('1.0', 1));
  const rebannered = applyBanner(stripBanner(bannered), bannerText('1.0', 5));
  expect(rebannered.length).toBe(t.length + 2);
  const bannerCount = rebannered.filter(m => m.role === 'user' && m.text.startsWith(BANNER_PREFIX)).length;
  expect(bannerCount).toBe(1);
  expect(rebannered[0].text).toContain('Currently 5 folds active.');
});
