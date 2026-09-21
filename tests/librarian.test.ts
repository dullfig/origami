import { test, expect } from 'claude-code/testing';
import { buildSweepPrompt, parseSweepReply, runLibrarian, LIBRARIAN_BATCH_SIZE } from '../hooks/librarian';
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

// --- batched parallel librarian calls ---

function manyCandidates(n: number): Candidate[] {
  return Array.from({ length: n }, (_, i) => ({
    ...cand, toolUseId: `t${i}`, text: `BODY ${i} `.repeat(50),
  }));
}

test('20 candidates split into two batches of at most LIBRARIAN_BATCH_SIZE', async () => {
  const seen: string[][] = [];
  const complete = async (req: { prompt: string }) => {
    const ids = [...req.prompt.matchAll(/<candidate id="([^"]+)"/g)].map(m => m[1]);
    seen.push(ids);
    return ids.map(id => `<decision id="${id}" action="fold">stub ${id}.</decision>`).join('\n');
  };
  const candidates = manyCandidates(20);
  const r = await runLibrarian(complete, 'haiku', candidates, false);
  expect(seen.length).toBe(2);
  expect(seen[0].length).toBe(LIBRARIAN_BATCH_SIZE);
  expect(seen[1].length).toBe(5);
  // no candidate is offered twice, and none is dropped
  expect([...seen[0], ...seen[1]]).toEqual(candidates.map(c => c.toolUseId));
  // merged in the caller's own candidate order
  expect(r.decisions.map(d => d.toolUseId)).toEqual(candidates.map(c => c.toolUseId));
  expect(r.decisions.every(d => d.action === 'fold')).toBe(true);
  expect(r.defaulted).toEqual([]);
  expect(r.unknown).toEqual([]);
  expect(r.inputTokens > 0).toBe(true);
  expect(r.outputTokens > 0).toBe(true);
});

test('a batch omitting every decision defaults only its OWN ids', async () => {
  const complete = async (req: { prompt: string }) => {
    const ids = [...req.prompt.matchAll(/<candidate id="([^"]+)"/g)].map(m => m[1]);
    // the batch that holds t15 (the second one) answers nothing at all
    if (ids.includes('t15')) return 'the model rambled and named no decision';
    return ids.map(id => `<decision id="${id}" action="fold">stub ${id}.</decision>`).join('\n');
  };
  const candidates = manyCandidates(20);
  const r = await runLibrarian(complete, 'haiku', candidates, false);
  expect(r.decisions.length).toBe(20);
  // batch 1 (t0..t14) still folded; batch 2 (t15..t19) defaulted to the safe keep
  expect(r.defaulted).toEqual(['t15', 't16', 't17', 't18', 't19']);
  expect(r.decisions.filter(d => d.action === 'fold').map(d => d.toolUseId))
    .toEqual(candidates.slice(0, 15).map(c => c.toolUseId));
  expect(r.decisions.filter(d => d.action === 'keep').map(d => d.toolUseId))
    .toEqual(['t15', 't16', 't17', 't18', 't19']);
});

test('at or below the batch size there is exactly one call — unchanged single-call behaviour', async () => {
  let calls = 0;
  const complete = async (req: { prompt: string }) => {
    calls += 1;
    return [...req.prompt.matchAll(/<candidate id="([^"]+)"/g)]
      .map(m => `<decision id="${m[1]}" action="fold">s.</decision>`).join('\n');
  };
  const r = await runLibrarian(complete, 'haiku', manyCandidates(LIBRARIAN_BATCH_SIZE), false);
  expect(calls).toBe(1);
  expect(r.decisions.length).toBe(LIBRARIAN_BATCH_SIZE);
});

// F14: a batch's `complete` call can itself reject (e.g. a safety-classifier refusal
// on security-dense content). Promise.all would let that one rejection discard every
// sibling batch's successfully-parsed work and fail the whole call; runLibrarian must
// instead degrade the rejected batch to "keep everything in it, defaulted" and still
// return the good batch's real decisions.
test('a batch whose complete() call rejects degrades to defaulted keeps without throwing, and the good batch still folds', async () => {
  const complete = async (req: { prompt: string }) => {
    const ids = [...req.prompt.matchAll(/<candidate id="([^"]+)"/g)].map(m => m[1]);
    if (ids.includes('t15')) throw new Error('refused: safety classifier');
    return ids.map(id => `<decision id="${id}" action="fold">stub ${id}.</decision>`).join('\n');
  };
  const candidates = manyCandidates(20);
  const r = await runLibrarian(complete, 'haiku', candidates, false);
  expect(r.decisions.length).toBe(20);
  // batch 1 (t0..t14) folded normally
  expect(r.decisions.filter(d => d.action === 'fold').map(d => d.toolUseId))
    .toEqual(candidates.slice(0, 15).map(c => c.toolUseId));
  // batch 2 (t15..t19), whose complete() rejected, is entirely defaulted to keep
  expect(r.decisions.filter(d => d.action === 'keep').map(d => d.toolUseId))
    .toEqual(['t15', 't16', 't17', 't18', 't19']);
  expect(r.defaulted).toEqual(['t15', 't16', 't17', 't18', 't19']);
  expect(r.unknown).toEqual([]);
  // tokens are counted only over the fulfilled batch
  expect(r.inputTokens > 0).toBe(true);
  expect(r.outputTokens > 0).toBe(true);
});

test('all batches rejecting yields no decisions folded — everything defaulted, no throw', async () => {
  const complete = async () => { throw new Error('model down'); };
  const r = await runLibrarian(complete, 'haiku', manyCandidates(20), false);
  expect(r.decisions.every(d => d.action === 'keep')).toBe(true);
  expect(r.defaulted.length).toBe(20);
  expect(r.inputTokens).toBe(0);
  expect(r.outputTokens).toBe(0);
});

test('an unknown id in one batch is reported without disturbing the other batch', async () => {
  const complete = async (req: { prompt: string }) => {
    const ids = [...req.prompt.matchAll(/<candidate id="([^"]+)"/g)].map(m => m[1]);
    const extra = ids.includes('t15') ? `\n<decision id="t_bogus" action="fold">ghost.</decision>` : '';
    return ids.map(id => `<decision id="${id}" action="fold">s.</decision>`).join('\n') + extra;
  };
  const r = await runLibrarian(complete, 'haiku', manyCandidates(20), false);
  expect(r.unknown).toEqual(['t_bogus']);
  expect(r.decisions.length).toBe(20);
  expect(r.decisions.every(d => d.action === 'fold')).toBe(true);
});
