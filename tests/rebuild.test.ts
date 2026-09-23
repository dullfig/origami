import { test, expect } from 'claude-code/testing';
import {
  rebuild, stubText, estimateTokens, turnAges,
  bannerText, stripBanner, applyBanner, BANNER_PREFIX, BANNER_ACK,
  sweepMarkerPair, foldIdsPresent, MARKER_PREFIX,
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

// --- Banner (controller amendment 2; v1.1 item 6 split it static/inline) ---

test('bannerText contains required elements and starts with BANNER_PREFIX', async () => {
  const b = bannerText('1.0');
  expect(b.startsWith(BANNER_PREFIX)).toBe(true);
  expect(b).toContain('ORIGAMI v1.0');
  expect(b).toContain('hydrate');
  expect(b).toContain('BETA DUTY');
  // F8: the model's own earlier messages are trustworthy; only stub-sourced claims are not
  expect(b).toContain('your own earlier messages are your record of what you saw');
  expect(b).toContain('Distrust only claims sourced from a stub alone.');
  // v1.1 item 6: the banner is now STATIC — no count, no per-sweep rewrite language
  expect(b).not.toContain('Currently');
  expect(b).not.toContain('(This notice is updated in place');
  expect(b).toContain('This notice is written once; per-sweep reports appear inline in the conversation below.');
});

test('applyBanner prepends a handle-less user+assistant pair', async () => {
  const t = transcript();
  const banner = bannerText('1.0');
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
  const bannered = applyBanner(t, bannerText('1.0'));
  const stripped = stripBanner(bannered);
  expect(stripped.length).toBe(t.length);
  expect(stripped.map(m => m.handle)).toEqual(t.map(m => m.handle));

  const noBanner = stripBanner(t);
  expect(noBanner.length).toBe(t.length);
  expect(noBanner.map(m => m.handle)).toEqual(t.map(m => m.handle));
});

test('re-banner round trip yields exactly one banner, identical text (static, no count)', async () => {
  const t = transcript();
  const bannered = applyBanner(t, bannerText('1.0'));
  const rebannered = applyBanner(stripBanner(bannered), bannerText('1.0'));
  expect(rebannered.length).toBe(t.length + 2);
  const bannerCount = rebannered.filter(m => m.role === 'user' && m.text.startsWith(BANNER_PREFIX)).length;
  expect(bannerCount).toBe(1);
  expect(rebannered[0].text).toBe(bannered[0].text); // static text is stable across rebanners
});

// --- Sweep marker pair (v1.1 item 6: mutable status moves inline) ---

test('sweepMarkerPair reports folded/restored ids and active count', async () => {
  const [user, ack] = sweepMarkerPair({ foldedIds: ['fold-013', 'fold-014'], restoredIds: ['fold-009'], activeFolds: 3 });
  expect(user.role).toBe('user');
  expect(user.handle).toBe(undefined);
  expect(user.text.startsWith(MARKER_PREFIX)).toBe(true);
  expect(user.text).toContain('folded fold-013, fold-014');
  expect(user.text).toContain('restored fold-009');
  expect(user.text).toContain('3 folds now active');
  expect(user.text).toContain('hydrate to recover it.');
  // CRITICAL: must never contain the stub prefix, or foldIdsPresent would immortalize
  // dead folds by reading a marker mention as a live stub
  expect(user.text.includes('[origami fold-')).toBe(false);
  expect(ack.role).toBe('assistant');
  expect(ack.handle).toBe(undefined);
  expect(ack.text).toBe('Noted. [synthetic acknowledgment inserted by origami]');
});

test('sweepMarkerPair renders empty folded/restored lists as "nothing"', async () => {
  const [user] = sweepMarkerPair({ foldedIds: [], restoredIds: [], activeFolds: 0 });
  expect(user.text).toContain('folded nothing');
  expect(user.text).toContain('restored nothing');
  expect(user.text).toContain('0 folds now active');
});

test('sweepMarkerPair announces stale ids as a bare, anchor-safe segment; omits it when none', async () => {
  const [withStale] = sweepMarkerPair({ foldedIds: [], restoredIds: [], activeFolds: 2, staleIds: ['fold-013', 'fold-014'] });
  expect(withStale.text).toContain('STALE');
  expect(withStale.text).toContain('fold-013, fold-014');
  // bare ids, never the stub prefix — foldIdsPresent must not immortalize them
  expect(withStale.text.includes('[origami fold-')).toBe(false);
  expect(foldIdsPresent([{ role: 'user', text: withStale.text, toolUses: [] }]).size).toBe(0);
  // no stale ids (and the field omitted entirely) => no STALE segment at all
  const [none] = sweepMarkerPair({ foldedIds: ['fold-001'], restoredIds: [], activeFolds: 1 });
  expect(none.text.includes('STALE')).toBe(false);
});

test('foldIdsPresent: a marker mention of a fold id is NOT stub presence; a real stub is', async () => {
  const [marker] = sweepMarkerPair({ foldedIds: ['fold-013'], restoredIds: [], activeFolds: 1 });
  const withMarkerOnly: SessionMessage[] = [{ role: 'user', text: marker.text, toolUses: [] }];
  expect(foldIdsPresent(withMarkerOnly).has('fold-013')).toBe(false);

  const withRealStub: SessionMessage[] = [
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: stubText('fold-013', 'Read', 'stub'), isError: false }] },
  ];
  expect(foldIdsPresent(withRealStub).has('fold-013')).toBe(true);
});

test('turnAges: a marker pair inserted between turns leaves surrounding ages unchanged', async () => {
  const t = transcript();
  const withoutMarker = turnAges(t);

  const marker = sweepMarkerPair({ foldedIds: ['fold-001'], restoredIds: [], activeFolds: 1 });
  const withMarker = [...t.slice(0, 4), ...marker, ...t.slice(4)];
  const ages = turnAges(withMarker);

  // ages of the original messages (now shifted by 2 after index 4) are unchanged
  expect(ages.slice(0, 4)).toEqual(withoutMarker.slice(0, 4));
  expect(ages.slice(6)).toEqual(withoutMarker.slice(4));
  // the marker's own two synthetic messages inherit the age of the turn they sit in
  expect(ages[4]).toBe(ages[3]);
  expect(ages[5]).toBe(ages[3]);
});
