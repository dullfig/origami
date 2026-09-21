import { test, expect } from 'claude-code/testing';
import { runSweep, storeIO, handleHydrate, observeMissedHydrate, ORIGAMI_VERSION } from '../hooks/origami';
import { readConfig } from '../hooks/origami';
import { getFold, allFolds, putFold, getKeeps, putKeep } from '../hooks/store';
import { BANNER_PREFIX, BANNER_ACK, bannerText, foldIndexMessage, contentHash, MARKER_PREFIX } from '../hooks/rebuild';
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
  // v1.1 item 6: the banner is now the STATIC text (no fold count baked in)
  expect(r.messages[0].text).toBe(bannerText(ORIGAMI_VERSION));
  expect(r.messages[1].text).toBe(BANNER_ACK);
  expect(r.messages[1].handle).toBe(undefined);
  expect(r.messages[4].toolResults![0].text.includes('fold-001')).toBe(true);
  // the mutable status lives at the tail as a sweep marker pair
  const tail = r.messages.slice(-2);
  expect(tail[0].role).toBe('user');
  expect(tail[0].text.startsWith(MARKER_PREFIX)).toBe(true);
  expect(tail[0].text).toContain('folded fold-001');
  expect(tail[0].text).toContain('restored nothing');
  expect(tail[0].text).toContain('1 folds now active');
  expect(tail[1].role).toBe('assistant');
  expect(tail[1].text).toBe('Noted. [synthetic acknowledgment inserted by origami]');
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

// --- incident fix: a sweep that throws must still arm the skip-mass cooldown, the
// same way an explicit skip does. Without this, a failing sweep re-fires the trigger
// and re-pays a full librarian call on every subsequent turn.
//
// NOTE (1.0.5, Fix 2): a librarian `complete()` rejection no longer reaches this catch
// path at all — runLibrarian (Promise.allSettled) now absorbs it and degrades the
// batch to defaulted keeps, so the sweep skips cleanly via the ordinary "librarian
// kept everything" branch instead (see the librarian-batch tests in librarian.test.ts,
// and interceptor test (a2) below for the non-memoization of that default). This test
// now exercises a genuinely different failure — a persistence error thrown well after
// the librarian has answered — to keep the catch block's own cooldown-arming logic
// covered. ---

test('a sweep that throws persisting a fold on a plugin trigger skips AND records the skip-mass cooldown', async () => {
  const fake = fakeEngine();
  const io = await storeIO(fake.$);
  expect(await io.storeGet('origami:lastSkipMass')).toBe(undefined);
  fake.setModelComplete(foldEverything);
  fake.failWritesWhen((path) => path.includes('/folds/'));   // the fold body write throws
  const r = await runSweep(fake.$, cfg, { trigger: 'plugin', messages: transcript() });
  expect((r as { skip?: string })?.skip).toBe('origami: sweep failed');
  // mirrors how the explicit-skip tests assert the cooldown: through the fake's io,
  // reached the same way the plugin (storeIO($)) reaches it
  const mass = await io.storeGet('origami:lastSkipMass');
  expect(typeof mass).toBe('number');
  expect((mass as number) > 0).toBe(true);
});

// --- incident fix: tolerant parsing. A librarian reply omitting a candidate's
// decision must not fail the whole sweep — the omitted candidate defaults to 'keep'
// (safe: its content just stays inline) and the sweep still succeeds and folds
// whatever the librarian DID decide. ---

function twoCandidateTranscript(): SessionMessage[] {
  const out: SessionMessage[] = [{ role: 'user', text: 'turn0', toolUses: [], handle: 'h0' }];
  out.push({
    role: 'assistant', text: '', handle: 'h1',
    toolUses: [
      { tool_use_id: 't1', tool: 'Read', input: { file_path: 'a.ts' } },
      { tool_use_id: 't2', tool: 'Read', input: { file_path: 'b.ts' } },
    ],
  });
  out.push({
    role: 'user', text: '', toolUses: [], handle: 'h2',
    toolResults: [
      { tool_use_id: 't1', text: 'CONTENT '.repeat(2000), isError: false },
      { tool_use_id: 't2', text: 'OTHER '.repeat(2000), isError: false },
    ],
  });
  for (let i = 1; i <= 4; i++) {
    out.push({ role: 'user', text: `turn${i}`, toolUses: [], handle: `hu${i}` });
    out.push({ role: 'assistant', text: `r${i}`, toolUses: [], handle: `ha${i}` });
  }
  return out;
}

test('a librarian reply omitting one of two candidates still succeeds, folds the decided one, and logs librarianDefaulted', async () => {
  const fake = fakeEngine();
  const io = await storeIO(fake.$);
  // answers only t1; t2 is left out entirely (a malformed/short reply, same shape as
  // the production incident) and must default to keep, not fail the sweep
  fake.setModelComplete(() => `<decision id="t1" action="fold">folded t1.</decision>`);
  const r = await runSweep(fake.$, cfg, { trigger: 'plugin', messages: twoCandidateTranscript() });
  if (!('messages' in r!) || !r.messages) throw new Error(`expected a rebuilt sweep, got ${JSON.stringify(r)}`);
  const folds = await allFolds(io);
  expect(folds.map(f => f.id)).toEqual(['fold-001']);
  expect(folds[0].toolUseId).toBe('t1');
  const stubs = r.messages.flatMap(m => m.toolResults ?? []).filter(x => x.text.startsWith('[origami '));
  expect(stubs.length).toBe(1);
  // t2's original content is still inline, verbatim — the safe default acted
  const t2Result = r.messages.flatMap(m => m.toolResults ?? []).find(x => x.tool_use_id === 't2');
  expect(t2Result!.text).toBe('OTHER '.repeat(2000));
  const log = String(await fake.$.fs.read('.claude/origami/origami.log'));
  expect(log.includes('"librarianDefaulted":1')).toBe(true);
});

// --- incident fix: unknown-id tolerance. A librarian reply that names one valid
// fold decision plus one unknown id (a garbled transcription of a candidate id,
// same shape as the production incident) must not fail the sweep — the unknown
// entry is dropped (it was never in expectedIds, so it can't corrupt decisions)
// and reported via librarianUnknown in the sweep log. ---

test('a librarian reply with one valid decision plus one unknown id still succeeds, folds the valid one, and logs librarianUnknown', async () => {
  const fake = fakeEngine();
  const io = await storeIO(fake.$);
  fake.setModelComplete(() =>
    `<decision id="t1" action="fold">folded t1.</decision>\n` +
    `<decision id="toolu_bogus_typo" action="fold">a hallucinated id.</decision>`,
  );
  const r = await runSweep(fake.$, cfg, { trigger: 'plugin', messages: twoCandidateTranscript() });
  if (!('messages' in r!) || !r.messages) throw new Error(`expected a rebuilt sweep, got ${JSON.stringify(r)}`);
  const folds = await allFolds(io);
  expect(folds.map(f => f.id)).toEqual(['fold-001']);
  expect(folds[0].toolUseId).toBe('t1');
  const log = String(await fake.$.fs.read('.claude/origami/origami.log'));
  expect(log.includes('"librarianUnknown":1')).toBe(true);
});

// --- finding 8(a): a second sweep over the first sweep's own output ---

test('two sweeps: banner kept by reference (idempotent), existing stubs are not re-folded, a second marker is appended', async () => {
  const fake = fakeEngine();
  const io = await storeIO(fake.$);
  fake.setModelComplete(foldEverything);

  const first = await runSweep(fake.$, cfg, { trigger: 'plugin', messages: transcript() });
  if (!('messages' in first!) || !first.messages) throw new Error('expected a rebuilt first sweep');
  expect((await allFolds(io)).map(f => f.id)).toEqual(['fold-001']);
  const firstMarker = first.messages.slice(-2); // [user marker, assistant ack] for fold-001

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
  // exactly one banner, at the top, text identical to the static banner (no count)
  const banners = r.messages.filter(m => m.role === 'user' && m.text.startsWith(BANNER_PREFIX));
  expect(banners.length).toBe(1);
  expect(r.messages[0].text.startsWith(BANNER_PREFIX)).toBe(true);
  expect(r.messages[0].text).toBe(bannerText(ORIGAMI_VERSION));
  expect(r.messages[1].text).toBe(BANNER_ACK);
  // KEY ASSERTION (v1.1 item 6, decision 2): the banner pair objects are the SAME
  // references as the first sweep's — not rebuilt. The fake-engine test kit passes
  // plain SessionMessage objects straight through (no wrapper/proxy), so reference
  // (`toBe`) identity is directly observable and is the strongest available proof of
  // handle preservation; a real handle field would show the same thing (both are
  // `undefined` here since the banner is synthetic and never carried a handle).
  expect(r.messages[0]).toBe(second[0]);
  expect(r.messages[0]).toBe(first.messages[0]);
  expect(r.messages[1]).toBe(second[1]);
  expect(r.messages[1]).toBe(first.messages[1]);
  // the first sweep's marker pair is untouched (same objects) — it sits mid-transcript
  // now, and is carried through by rebuild()'s "not touched -> same reference" path
  const firstMarkerIndexInR = r.messages.findIndex(m => m === firstMarker[0]);
  expect(firstMarkerIndexInR).toBeGreaterThan(1); // present, after the banner pair
  expect(r.messages[firstMarkerIndexInR]).toBe(firstMarker[0]);
  expect(r.messages[firstMarkerIndexInR + 1]).toBe(firstMarker[1]);
  expect(r.messages[firstMarkerIndexInR].text).toContain('folded fold-001');
  // a second marker pair is appended at the tail, reporting this sweep's fold
  const secondMarker = r.messages.slice(-2);
  expect(secondMarker[0].role).toBe('user');
  expect(secondMarker[0].text.startsWith(MARKER_PREFIX)).toBe(true);
  expect(secondMarker[0].text).toContain('folded fold-002');
  expect(secondMarker[0].text).toContain('restored nothing');
  expect(secondMarker[0].text).toContain('2 folds now active');
  expect(secondMarker[1].text).toBe('Noted. [synthetic acknowledgment inserted by origami]');
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
  // only the live fold counts — now reported by the tail marker, not the (static) banner
  const tail = r.messages.slice(-2);
  expect(tail[0].text.startsWith(MARKER_PREFIX)).toBe(true);
  expect(tail[0].text).toContain('1 folds now active');
  // the observer no longer reports a re-read of it as a missed hydrate
  await observeMissedHydrate(fake.$, { tool: 'Read', input: { file_path: 'gone.ts' } });
  const log = String(await fake.$.fs.read('.claude/origami/origami.log'));
  expect(log.includes('"event":"missed_hydrate"')).toBe(false);
  // hydrate still serves the stored body, and says the fold is evicted
  const h = await handleHydrate(fake.$, cfg, 'fold-000');
  expect(h.includes('ORPHANED BODY')).toBe(true);
  expect(h.includes('evicted')).toBe(true);
});

// --- F10: a manual /compact must not hand a folded context to the stock summarizer ---

// a transcript with nothing foldable left: the only tool result is fold-001's own stub
function sweptTranscript(): SessionMessage[] {
  const out: SessionMessage[] = [{ role: 'user', text: 'turn0', toolUses: [], handle: 'h0' }];
  out.push({ role: 'assistant', text: '', toolUses: [{ tool_use_id: 't1', tool: 'Read', input: { file_path: 'a.ts' } }], handle: 'h1' });
  out.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: '[origami fold-001 · Read result folded] s — call hydrate("fold-001") for the full content.', isError: false }], handle: 'h2' });
  for (let i = 1; i <= 4; i++) {
    out.push({ role: 'user', text: `turn${i}`, toolUses: [], handle: `hu${i}` });
    out.push({ role: 'assistant', text: `r${i}`, toolUses: [], handle: `ha${i}` });
  }
  return out;
}

test('manual compaction with nothing to fold is SKIPPED while live folds exist', async () => {
  const fake = fakeEngine();
  const io = await storeIO(fake.$);
  await putFold(io, {
    id: 'fold-001', stub: 's', state: 'folded', tool: 'Read', toolUseId: 't1',
    inputKey: 'a.ts', originAge: 3, sizeTokens: 4000, hydrations: 0,
  }, 'BODY');
  const r = await runSweep(fake.$, cfg, { trigger: 'manual', messages: sweptTranscript() });
  const skip = (r as { skip?: string })?.skip;
  expect(typeof skip).toBe('string');
  expect(skip!.includes('live folds')).toBe(true);
  expect(skip!.includes('1 live folds')).toBe(true);
  // the fold survived the guard: it was not evicted, so the stubs it protects stay valid
  expect((await allFolds(io)).find(f => f.id === 'fold-001')!.state).toBe('folded');
});

test('manual compaction with nothing to fold and NO live folds still passes through', async () => {
  const fake = fakeEngine();
  const r = await runSweep(fake.$, cfg, { trigger: 'manual', messages: sweptTranscript() });
  expect(r).toBe(undefined);   // stock compaction is harmless with nothing to lose
});

test('a sweep that throws mid-way still guards a manual compaction when folds are live', async () => {
  const fake = fakeEngine();
  const io = await storeIO(fake.$);
  await putFold(io, {
    id: 'fold-001', stub: 's', state: 'folded', tool: 'Read', toolUseId: 'tOld',
    inputKey: 'a.ts', originAge: 3, sizeTokens: 4000, hydrations: 0,
  }, 'BODY');
  fake.setModelComplete(() => { throw new Error('model down'); });
  // fold-001's stub is present, so the lifecycle reconcile keeps it live; transcript()
  // also has real foldable mass, so the librarian is reached — and throws AFTER the
  // fold index was read. liveFolds is known, so the guard still applies.
  const t = transcript();
  t[0] = { ...t[0], text: 'turn0 — see [origami fold-001 · Read result folded] s' };
  const r = await runSweep(fake.$, cfg, { trigger: 'manual', messages: t });
  const skip = (r as { skip?: string })?.skip;
  expect(typeof skip).toBe('string');
  expect(skip!.includes('live folds')).toBe(true);
});

// --- F10, `auto` row: fold-index insurance. The registered session.compact hook
// appends this message to the event it passes to next(); only the pure builder is
// reachable from the test kit (registering hooks and driving a real compaction
// through next() is not), so the message's shape is covered here and the hook's
// wiring was verified by reading it. ---

test('foldIndexMessage lists every live fold and is undefined when none is live', async () => {
  const live = [
    { id: 'fold-001', stub: 'auth flow notes', state: 'folded' as const },
    { id: 'fold-007', stub: 'the failing test output', state: 'pinned' as const },
    { id: 'fold-009', stub: 'gone', state: 'evicted' as const },
  ];
  const m = foldIndexMessage(live)!;
  expect(m.role).toBe('user');
  expect(m.handle).toBe(undefined);
  expect(m.text.startsWith('[origami fold index — preserve these recovery links in any summary]')).toBe(true);
  expect(m.text).toContain('fold-001 — auth flow notes');
  expect(m.text).toContain('fold-007 — the failing test output');
  expect(m.text.includes('fold-009')).toBe(false);          // evicted folds are not live
  expect(foldIndexMessage([])).toBe(undefined);
  expect(foldIndexMessage([live[2]])).toBe(undefined);      // only-evicted is no index
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

// --- DELTA SWEEPS: keep-verdict memory ---
// Both observed live sweeps re-read essentially the same content: candidates the
// librarian had already ruled `keep` stayed inline, aged and bulky, and were
// re-offered wholesale. A steady-state sweep must read only NEW mass.

// a completion handler that records every call so a test can assert the librarian
// was NOT reached at all
function recordingLibrarian(reply: (req: { prompt: string }) => string) {
  const prompts: string[] = [];
  return {
    prompts,
    get calls() { return prompts.length; },
    handler: (req: { prompt: string }) => { prompts.push(req.prompt); return reply(req); },
  };
}

test('(a) a kept candidate is not re-offered: the second sweep never calls the librarian', async () => {
  const fake = fakeEngine();
  const io = await storeIO(fake.$);
  const lib = recordingLibrarian(() =>
    `<decision id="t1" action="fold">folded t1.</decision>\n<decision id="t2" action="keep">keep t2</decision>`);
  fake.setModelComplete(lib.handler);

  const first = await runSweep(fake.$, cfg, { trigger: 'plugin', messages: twoCandidateTranscript() });
  if (!('messages' in first!) || !first.messages) throw new Error('expected a rebuilt first sweep');
  expect(lib.calls).toBe(1);
  expect(lib.prompts[0].includes('<candidate id="t1"')).toBe(true);
  expect(lib.prompts[0].includes('<candidate id="t2"')).toBe(true);
  // the keep verdict is remembered against t2's exact content
  const keeps = await getKeeps(io);
  expect([...keeps.keys()]).toEqual(['t2']);
  expect(keeps.get('t2')!.hash).toBe(contentHash('OTHER '.repeat(2000)));

  // second sweep over the first sweep's own output: t1 is a stub (never re-folded),
  // t2 is unchanged and keep-remembered — so NOTHING is offered
  const second = await runSweep(fake.$, cfg, { trigger: 'plugin', messages: first.messages });
  expect(lib.calls).toBe(1);                                   // the librarian was never reached
  expect((second as { skip?: string }).skip).toBe('origami: nothing to fold');
  // t2's content is untouched and its memory intact
  expect((await getKeeps(io)).get('t2')!.hash).toBe(contentHash('OTHER '.repeat(2000)));
});

// A candidate the librarian OMITS (never actually judged) is not the same as one it
// explicitly ruled keep: parseSweepReply defaults it to keep as a safety fallback for
// THIS sweep only. Memoizing that default would suppress the candidate from every
// future non-aggressive sweep, permanently — so it must get NO keep entry, and must be
// re-offered (and get a real chance at judgment) next sweep.
test('(a2) a defaulted (omitted) keep folds nothing this sweep, is NOT memoized, and is re-offered next sweep', async () => {
  const fake = fakeEngine();
  const io = await storeIO(fake.$);
  // t1 is judged (fold); t2 is left out of the reply entirely — a default, not a verdict
  const lib = recordingLibrarian(() => `<decision id="t1" action="fold">folded t1.</decision>`);
  fake.setModelComplete(lib.handler);

  const first = await runSweep(fake.$, cfg, { trigger: 'plugin', messages: twoCandidateTranscript() });
  if (!('messages' in first!) || !first.messages) throw new Error('expected a rebuilt first sweep');
  expect(lib.calls).toBe(1);
  // t2's content stays inline verbatim (the safe default acted)...
  const t2Result = first.messages.flatMap(m => m.toolResults ?? []).find(x => x.tool_use_id === 't2');
  expect(t2Result!.text).toBe('OTHER '.repeat(2000));
  // ...but no keep-memory entry exists for it — unlike an EXPLICIT keep (see test (a))
  expect((await getKeeps(io)).has('t2')).toBe(false);

  // second, identical sweep over the first sweep's own output: with no keep entry to
  // suppress it, t2 must be re-offered to the librarian for a real judgment
  const second = await runSweep(fake.$, cfg, { trigger: 'plugin', messages: first.messages });
  expect(lib.calls).toBe(2);
  expect(lib.prompts[1].includes('<candidate id="t2"')).toBe(true);
});

test('(b) a keep entry whose hash no longer matches is dropped and the candidate is re-offered', async () => {
  const fake = fakeEngine();
  const io = await storeIO(fake.$);
  // a verdict recorded against DIFFERENT content than t1 now carries
  await putKeep(io, 't1', contentHash('what the librarian saw last time'));
  const lib = recordingLibrarian(foldEverything);
  fake.setModelComplete(lib.handler);

  const r = await runSweep(fake.$, cfg, { trigger: 'plugin', messages: transcript() });
  if (!('messages' in r!) || !r.messages) throw new Error('expected a rebuilt sweep');
  expect(lib.calls).toBe(1);
  expect(lib.prompts[0].includes('<candidate id="t1"')).toBe(true);   // re-offered
  expect((await allFolds(io)).map(f => f.toolUseId)).toEqual(['t1']);
  // a fold verdict clears the memory: the content is a stub now
  expect((await getKeeps(io)).has('t1')).toBe(false);
});

test('(c) an aggressive sweep ignores keep-memory and re-offers the kept candidate', async () => {
  const fake = fakeEngine();
  const io = await storeIO(fake.$);
  // t1 is keep-remembered against exactly the content it still carries
  await putKeep(io, 't1', contentHash('CONTENT '.repeat(2000)));
  const quiet = recordingLibrarian(foldEverything);
  fake.setModelComplete(quiet.handler);
  // non-aggressive first: keep-memory holds, nothing is offered
  const calm = await runSweep(fake.$, cfg, { trigger: 'plugin', messages: transcript() });
  expect(quiet.calls).toBe(0);
  expect((calm as { skip?: string }).skip).toBe('origami: nothing to fold');
  expect((await getKeeps(io)).has('t1')).toBe(true);            // still remembered

  // now the working set is over budget — the sweep must be able to REVERSE the keep
  await io.storeSet('origami:aggressive', true);
  const r = await runSweep(fake.$, cfg, { trigger: 'plugin', messages: transcript() });
  if (!('messages' in r!) || !r.messages) throw new Error('expected a rebuilt aggressive sweep');
  expect(quiet.calls).toBe(1);
  expect(quiet.prompts[0].includes('<candidate id="t1"')).toBe(true);
  expect(quiet.prompts[0].includes('over budget')).toBe(true);
  expect((await allFolds(io)).map(f => f.toolUseId)).toEqual(['t1']);
  expect((await getKeeps(io)).has('t1')).toBe(false);           // the keep was reversed
});

test('the reconcile pass prunes a keep entry whose toolUseId has left the transcript', async () => {
  const fake = fakeEngine();
  const io = await storeIO(fake.$);
  await putKeep(io, 'tGone', 'some-hash');                      // an id no transcript carries
  await putKeep(io, 't1', 'a-stale-hash');                      // present, but stale
  fake.setModelComplete(foldEverything);
  const r = await runSweep(fake.$, cfg, { trigger: 'plugin', messages: transcript() });
  if (!('messages' in r!) || !r.messages) throw new Error('expected a rebuilt sweep');
  const keeps = await getKeeps(io);
  expect(keeps.has('tGone')).toBe(false);                       // dead entry pruned
  expect(keeps.has('t1')).toBe(false);                          // stale then folded
});
