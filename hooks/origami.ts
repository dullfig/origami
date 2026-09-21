import type { Register, EngineInterface, SessionCompactInput, SessionCompactResult, SessionMessage } from 'claude-code';
import { selectCandidates, rebuild, bannerText, stripBanner, applyBanner, foldIdsPresent, foldIndexMessage, sweepMarkerPair, contentHash, BANNER_PREFIX, BANNER_ACK, type Candidate, type FoldDecision, type RestoreDecision, candidateMass, estimateTokens } from './rebuild';
import { runLibrarian, type CompleteFn } from './librarian';
import { newFoldId, putFold, getFold, setFold, allFolds, getKeeps, putKeep, dropKeep, appendLog, inputKeyOf, type FoldEntry, type KeepEntry, type StoreIO } from './store';

// $.store is PLUGIN-GLOBAL: one JSON file under the user's Claude Code config dir
// (types/claude-code.d.ts ~:2823-2830), shared by every project this plugin runs in.
// $.fs relative paths are NOT — they resolve under the session's working directory
// (~:2700-2702), so fold BODIES are already project-local while the index would leak.
// $.session.root() (~:2364-2369, "the session's project root, absolute") is the stable
// per-project discriminator; a short hash of it prefixes every store key.
function projectHash(root: string): string {
  let h = 0x811c9dc5;                                   // FNV-1a, 32-bit
  for (let i = 0; i < root.length; i++) {
    h ^= root.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

// SAME-FILE closures over $: the engine validator follows $ only into functions
// declared in this file, never across an import, so these adapters must live here
// and be built at each hook call site before crossing into store.ts/librarian.ts.
// The project prefix is baked INTO the closures, so store.ts never sees it: keys go
// in prefixed and come back out of storeKeys() stripped, keeping the `origami:fold:`
// filtering in store.ts unchanged.
export async function storeIO($: EngineInterface): Promise<StoreIO> {
  let prefix = 'origami@0/';
  try {
    const root = await $.session.root();
    if (typeof root === 'string' && root !== '') prefix = `origami@${projectHash(root)}/`;
  } catch { /* a host without session.root keeps the single shared namespace */ }
  return {
    fsRead: async (path) => String(await $.fs.read(path)),
    fsWrite: (path, text) => $.fs.write(path, text),
    fsExists: (path) => $.fs.exists(path),
    storeGet: (key) => $.store.get(prefix + key),
    storeSet: (key, value) => $.store.set(prefix + key, value),
    storeDelete: (key) => $.store.delete(prefix + key),
    storeKeys: async () => (await $.store.keys())
      .filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length)),
  };
}
function completeWith($: EngineInterface): CompleteFn {
  return (req) => $.model.complete(req);
}

// Keep in sync with .claude-plugin/plugin.json's "version".
export const ORIGAMI_VERSION = '1.0.4';

export type OrigamiConfig = {
  foldAgeTurns: number;
  minFoldMass: number;
  workingSetBudget: number;
  preserveRecentTurns: number;
  minReductionRatio: number;
  pinAfterHydrations: number;
  librarianModel: string;
};

const DEFAULTS: OrigamiConfig = {
  foldAgeTurns: 3,
  minFoldMass: 20000,
  workingSetBudget: 100000,
  preserveRecentTurns: 3,
  minReductionRatio: 0.15,
  pinAfterHydrations: 2,
  librarianModel: 'haiku',
};

export function readConfig(options: unknown): OrigamiConfig {
  const o = (options ?? {}) as Partial<Record<keyof OrigamiConfig, unknown>>;
  const num = (k: keyof OrigamiConfig) =>
    typeof o[k] === 'number' && Number.isFinite(o[k] as number) ? (o[k] as number) : (DEFAULTS[k] as number);
  return {
    foldAgeTurns: num('foldAgeTurns'),
    minFoldMass: num('minFoldMass'),
    workingSetBudget: num('workingSetBudget'),
    preserveRecentTurns: num('preserveRecentTurns'),
    minReductionRatio: num('minReductionRatio'),
    pinAfterHydrations: num('pinAfterHydrations'),
    librarianModel: typeof o.librarianModel === 'string' ? o.librarianModel : DEFAULTS.librarianModel,
  };
}

// A sweep that ends in a skip (reduction below threshold, librarian kept everything)
// records the candidate mass it skipped on. The trigger then stays quiet until the
// mass has meaningfully grown, so the same fruitless librarian call cannot repeat
// every turn forever. Cleared on any successful sweep.
const LAST_SKIP_MASS = 'origami:lastSkipMass';
const SKIP_COOLDOWN_FACTOR = 1.2;
const AGGRESSIVE = 'origami:aggressive';

// A candidate is keep-remembered when a previous sweep's librarian ruled it `keep`
// AND its content still hashes to what that verdict was made about. Shared by the
// trigger (which must not fire on mass the sweep will not offer) and the sweep
// itself (which must not re-offer it), so the two can never disagree.
export function isKeepRemembered(keeps: ReadonlyMap<string, KeepEntry>, c: Candidate): boolean {
  const k = keeps.get(c.toolUseId);
  return k !== undefined && k.hash === contentHash(c.text);
}

export async function shouldSweep(
  $: EngineInterface, cfg: OrigamiConfig, messagesArg?: readonly SessionMessage[],
): Promise<{ sweep: boolean; aggressive: boolean }> {
  const io = await storeIO($);
  const messages = messagesArg ?? await $.session.messages();
  // every live fold's original result is already folded (or pinned open) — its mass
  // must never re-trigger a sweep, whichever transcript view messages() returns
  const excluded = new Set((await allFolds(io)).filter(f => f.state !== 'evicted').map(f => f.toolUseId));
  // F11: the same discount applies to the working-set figure. A raw transcript view
  // still carrying already-folded results must not push the session into aggressive
  // mode on mass that is, on disk, already reduced.
  //
  // ASYMMETRY, deliberate: `excluded` (live folds) is discounted from BOTH figures
  // below, but keep-memory is discounted from the CANDIDATE MASS only and never from
  // liveTokens. The two figures answer different questions. Candidate mass asks "is
  // there work a sweep would actually do?" — and a non-aggressive sweep will not
  // re-offer keep-remembered content, so counting it there makes the trigger fire
  // forever on mass no sweep will ever fold (the livelock cousin of the skip-mass
  // loop). liveTokens asks "how full is the context?" — and kept content is genuinely
  // live, un-reduced, still-in-the-window text. Discounting it there would hide real
  // budget pressure and suppress exactly the aggressive sweep that exists to REVERSE
  // those earlier keeps.
  const liveTokens = messages.reduce((s, m) => s + estimateTokens(m.text)
    + (m.toolResults ?? []).reduce((a, r) => a + (excluded.has(r.tool_use_id) ? 0 : estimateTokens(r.text)), 0), 0);
  const aggressive = liveTokens > cfg.workingSetBudget;
  const keeps = await getKeeps(io);
  const mass = candidateMass(
    selectCandidates(messages, excluded, cfg, aggressive)
      .filter(c => !c.text.startsWith('[origami fold-'))
      // an aggressive sweep ignores keep-memory and re-offers everything, so the
      // trigger must not discount it either
      .filter(c => aggressive || !isKeepRemembered(keeps, c)),
  );
  const triggered = mass >= cfg.minFoldMass || (aggressive && mass > 0);
  const lastSkipMass = Number((await io.storeGet(LAST_SKIP_MASS)) ?? 0);
  const cooled = !(lastSkipMass > 0) || mass > lastSkipMass * SKIP_COOLDOWN_FACTOR;
  return { sweep: triggered && cooled, aggressive };
}

// returns a result to answer with, or undefined = caller must pass through via next(e)
export async function runSweep(
  $: EngineInterface, cfg: OrigamiConfig, e: Pick<SessionCompactInput, 'trigger' | 'agentId' | 'messages'>,
): Promise<SessionCompactResult | undefined> {
  if (e.agentId) return undefined;                       // main thread only
  // PRECOMPUTE: still passed through, DELIBERATELY, on evidence rather than caution.
  // The caching semantics ARE clear — types/claude-code.d.ts :8523-8524 ("`precompute`
  // is the one dispatch that installs nothing: its result is kept for the compaction
  // that comes, if the conversation it ran over still leads") and :8443-8445 ("What the
  // transcript becomes (kept, on `precompute`, for the compaction that comes)"). So a
  // precompute answer is cached and later applied, not run immediately, and answering
  // it would NOT double-run the librarian for a precompute that is used.
  //
  // What blocks it is the DISCARD path, which the same sentence declares: the result
  // is kept only "if the conversation it ran over still leads". runSweep is not pure —
  // it allocates fold ids, writes body files and persists `state: 'folded'` entries.
  // On a discarded precompute those entries exist while their stubs never reached the
  // transcript, and shouldSweep excludes every non-evicted fold's toolUseId from the
  // candidate mass (see `excluded` above). The trigger would then stay quiet on mass
  // that is still fully inline, and only a sweep's reconcile pass can evict the orphans
  // — a sweep the suppressed trigger never fires. That is a livelock, not a cost.
  // :8511-8517 (`SessionCompactSkipped`: "on `precompute` nothing is computed or kept")
  // is the only declared escape, and it is exactly what this early return takes.
  //
  // Answering precompute safely needs deferred persistence (buffer the fold entries,
  // commit them when the result is actually installed), and NOTHING in the declarations
  // tells a hook whether its precomputed result was installed. Out of scope here.
  if (e.trigger === 'precompute') return undefined;
  // F10: what a stock compaction would destroy if origami passes this event through.
  // Declared OUTSIDE the try so the catch path can apply the same guard: a sweep that
  // throws after the index was read (librarian down, rebuild invariant) must not hand
  // a folded context to the stock summarizer either. An exception BEFORE the index is
  // read leaves this [] — origami then has no verified picture and passes through.
  let liveFolds: FoldEntry[] = [];
  const manualGuard = (): SessionCompactResult | undefined =>
    e.trigger === 'manual' && liveFolds.length > 0
      ? { skip: `origami: nothing to fold — ${liveFolds.length} live folds already active; stock compaction would destroy their stubs` }
      : undefined;
  // Hoisted OUTSIDE the try for the same reason as liveFolds: the catch path needs
  // them too. `io` is normally built at the top of the try, but a throw can happen
  // before that assignment runs (or the try itself could fail differently later), so
  // it is declared here and assigned as soon as it exists. `sweepCandidateMass` is
  // set once candidates are selected; if the librarian call (or anything after it)
  // then throws, the catch block still has the mass to arm the skip-mass cooldown —
  // without this, a failing sweep re-fires the trigger and re-pays a full librarian
  // call every turn instead of backing off like the explicit skip outcomes do.
  let io: StoreIO | undefined;
  let sweepCandidateMass = 0;
  try {
    io = await storeIO($);
    // v1.1 item 6 (banner split/idempotence): the banner is STATIC — written once,
    // rules only. If index 0/1 already carry exactly today's banner text, keep those
    // ORIGINAL message objects (same references, handles intact) at assembly time
    // instead of rebuilding them; that is the prompt-cache win. Detected against the
    // raw event messages, before stripping.
    const currentBanner = bannerText(ORIGAMI_VERSION);
    const bannerUnchanged = e.messages[0]?.role === 'user' && e.messages[0].text.startsWith(BANNER_PREFIX)
      && e.messages[0].text === currentBanner
      && e.messages[1]?.role === 'assistant' && e.messages[1].text === BANNER_ACK;
    // strip any existing banner pair first: all subsequent logic (reconcile scan,
    // candidate selection, restores, rebuild) runs on the stripped array, never on
    // e.messages directly — this holds whether or not the banner is being kept,
    // since rebuild() never touches the banner pair either way (no toolResults).
    const messages = stripBanner(e.messages);
    // --- lifecycle reconcile: a 'folded' entry whose stub no longer appears anywhere
    // in the transcript is dead (unpin->refold replaced it, the stub was edited away,
    // the turn was rewound). Left alone it inflates the banner count forever and feeds
    // missed_hydrate false positives. Entries created BY this sweep are not yet in the
    // store, so reconciling here — before any creation — can never evict them.
    const stubIds = foldIdsPresent(messages);
    for (const f of await allFolds(io)) {
      if (f.state === 'folded' && !stubIds.has(f.id)) await setFold(io, { ...f, state: 'evicted' });
    }
    // Keep-memory lifecycle, same reconcile pass: an entry whose tool_use_id no longer
    // appears anywhere in this transcript view is dead (the turn was rewound, the
    // result was compacted away by something else) and would otherwise accumulate
    // forever in a plugin-global store. Collecting the live ids is one cheap scan.
    const liveToolUseIds = new Set<string>();
    for (const m of messages) for (const r of m.toolResults ?? []) liveToolUseIds.add(r.tool_use_id);
    const keeps = await getKeeps(io);
    for (const id of [...keeps.keys()]) {
      if (!liveToolUseIds.has(id)) { await dropKeep(io, id); keeps.delete(id); }
    }
    const folds = await allFolds(io);
    // pinned folds stay open: once restored inline their big results must never
    // become candidates again, so exclusion is by the toolUseId the entry recorded
    const excluded = new Set(folds.filter(f => f.state === 'pinned').map(f => f.toolUseId));
    liveFolds = folds.filter(f => f.state === 'folded' || f.state === 'pinned');
    const aggressive = Boolean(await io.storeGet(AGGRESSIVE));
    const candidates = selectCandidates(messages, excluded, cfg, aggressive)
      .filter(c => !c.text.startsWith('[origami fold-'));  // never re-fold a stub
    // --- DELTA SWEEP: partition candidates against keep-memory ---
    // A candidate the librarian already ruled `keep`, whose content still hashes the
    // same, needs no new decision: it stays inline exactly as it is. Excluding it from
    // the offer is the whole point — steady-state sweeps prefill only NEW mass instead
    // of re-reading the entire kept working set every time.
    //
    // AGGRESSIVE OVERRIDE: an over-budget sweep must be able to REVERSE earlier keeps,
    // so it ignores keep-memory entirely and re-offers everything.
    const offered: Candidate[] = [];
    for (const c of candidates) {
      if (!aggressive && isKeepRemembered(keeps, c)) continue;
      // a stale entry (same id, different content) no longer describes anything the
      // librarian saw: drop it now and let the fresh decision below replace it
      if (!aggressive && keeps.has(c.toolUseId)) await dropKeep(io, c.toolUseId);
      offered.push(c);
    }
    sweepCandidateMass = candidateMass(offered);
    // reopen pinned folds whose stubs still sit in history
    const restores: RestoreDecision[] = [];
    for (const f of folds.filter(f => f.state === 'pinned')) {
      for (const m of messages) {
        for (const r of m.toolResults ?? []) {
          if (r.text.includes(`[origami ${f.id} `)) {
            const stored = await getFold(io, f.id);
            if (stored) restores.push({ toolUseId: r.tool_use_id, foldId: f.id, body: stored.body });
          }
        }
      }
    }
    // Nothing OFFERED (not merely nothing selected): a sweep whose whole candidate set
    // is keep-remembered has no question to ask and must not pay a librarian call.
    if (offered.length === 0 && restores.length === 0) {
      if (e.trigger === 'plugin') return { skip: 'origami: nothing to fold' };
      return manualGuard();   // manual+live folds → skip; otherwise pass through
    }
    const lib = offered.length > 0
      ? await runLibrarian(completeWith($), cfg.librarianModel, offered, aggressive)
      : { decisions: [], defaulted: [], unknown: [], inputTokens: 0, outputTokens: 0 };
    // Record the verdicts. A `keep` (explicit or defaulted — parseSweepReply makes
    // both come back as action 'keep') is remembered against the content it was made
    // about; a `fold` clears any entry, since the content is about to become a stub.
    for (const d of lib.decisions) {
      const c = offered.find(x => x.toolUseId === d.toolUseId);
      if (!c) continue;
      if (d.action === 'keep') await putKeep(io, d.toolUseId, contentHash(c.text));
      else if (keeps.has(d.toolUseId)) await dropKeep(io, d.toolUseId);
    }
    // Ids are allocated and bodies BUFFERED here; nothing is persisted until rebuild
    // has cleared the reduction gate. Persisting first left orphan entries + body
    // files behind on every skipped sweep, inflating the banner count and feeding
    // missed_hydrate false positives.
    const foldDecisions: FoldDecision[] = [];
    const pending: { entry: FoldEntry; body: string; header: string }[] = [];
    for (const d of lib.decisions) {
      if (d.action !== 'fold') continue;
      const c = candidates.find(x => x.toolUseId === d.toolUseId)!;
      const id = await newFoldId(io);
      const stub = d.stub.replaceAll('hydrate://FOLD#', `hydrate://${id}#`); // librarian writes the FOLD token; the real id lands here
      const entry: FoldEntry = { id, stub, state: 'folded', tool: c.tool, toolUseId: c.toolUseId, inputKey: inputKeyOf(c.input), originAge: c.ageTurns, sizeTokens: c.sizeTokens, hydrations: 0 };
      // body is c.text VERBATIM; the header rides in its own slot so restores are
      // byte-exact and refolding a restored body cannot nest a second header
      pending.push({ entry, body: c.text, header: `# ${id} · ${c.tool} ${JSON.stringify(c.input)}` });
      foldDecisions.push({ toolUseId: d.toolUseId, foldId: id, stub });
    }
    if (foldDecisions.length === 0 && restores.length === 0) {
      await io.storeSet(LAST_SKIP_MASS, candidateMass(offered));   // the offer, not the selection: shouldSweep discounts keeps the same way
      if (e.trigger === 'plugin') return { skip: 'origami: librarian kept everything' };
      return manualGuard();
    }
    const outcome = rebuild(messages, foldDecisions, restores, cfg, aggressive);
    if (outcome.kind === 'insufficient') {
      await io.storeSet(LAST_SKIP_MASS, candidateMass(offered));   // the offer, not the selection: shouldSweep discounts keeps the same way
      if (e.trigger === 'plugin') return { skip: `origami: reduction ${outcome.ratio.toFixed(2)} below threshold` };
      return manualGuard();
    }
    for (const p of pending) await putFold(io, p.entry, p.body, p.header);
    await io.storeSet(LAST_SKIP_MASS, 0);
    await io.storeSet(AGGRESSIVE, false);
    const activeFolds = (await allFolds(io)).filter(f => f.state === 'folded').length;
    // Reuse the original banner pair (same object references) when its text is
    // already current; otherwise rebuild it (migration bust: old-style count-bearing
    // banner, or a version bump). Either way, append this sweep's marker pair at the
    // tail — the mutable status that used to live in the banner's count.
    const marker = sweepMarkerPair({
      foldedIds: foldDecisions.map(d => d.foldId),
      restoredIds: restores.map(r => r.foldId),
      activeFolds,
    });
    const finalMessages = bannerUnchanged
      ? [e.messages[0], e.messages[1], ...outcome.messages, ...marker]
      : [...applyBanner(outcome.messages, currentBanner), ...marker];
    await appendLog(io, {
      event: 'sweep', trigger: e.trigger, aggressive,
      tokensBefore: outcome.tokensBefore, tokensAfter: outcome.tokensAfter,
      librarianInputTokens: lib.inputTokens, librarianOutputTokens: lib.outputTokens,
      ...(lib.defaulted.length > 0 ? { librarianDefaulted: lib.defaulted.length } : {}),
      ...(lib.unknown.length > 0 ? { librarianUnknown: lib.unknown.length } : {}),
      foldsCreated: foldDecisions.length, restores: restores.length, foldsActive: activeFolds,
    });
    return { messages: finalMessages, tokensBefore: outcome.tokensBefore, tokensAfter: outcome.tokensAfter };
  } catch (err) {
    $.ui.log(`origami sweep failed, falling back: ${err instanceof Error ? err.message : String(err)}`);
    // Arm the same skip-mass cooldown a clean skip would: without it, a sweep that
    // fails (librarian down, transient model error) re-fires the trigger and re-pays
    // a full librarian call on every subsequent turn instead of backing off. Guarded
    // in its own try/catch so a store failure here can never mask the original error.
    if (io && sweepCandidateMass > 0) {
      try { await io.storeSet(LAST_SKIP_MASS, sweepCandidateMass); } catch { /* best-effort */ }
    }
    if (e.trigger === 'plugin') return { skip: 'origami: sweep failed' };
    return manualGuard();   // a failed sweep is still no reason to let stock wipe live stubs
  }
}

// A tool.call hook must ANSWER, never throw: a throw escapes the tool and takes the
// turn with it. Both handlers are therefore total — every failure path (missing body
// file, store or fs refusal) comes back as instructive text the model can act on.
export async function handleHydrate($: EngineInterface, cfg: OrigamiConfig, foldId: string, anchor?: string): Promise<string> {
  try {
    const io = await storeIO($);
    const found = await getFold(io, foldId);
    if (!found) return `Unknown fold id "${foldId}". Fold ids look like fold-001 and appear in [origami fold-…] stubs in the conversation.`;
    const hydrations = found.entry.hydrations + 1;
    const pinned = hydrations >= cfg.pinAfterHydrations && found.entry.state === 'folded';
    await setFold(io, { ...found.entry, hydrations, state: pinned ? 'pinned' : found.entry.state });
    await appendLog(io, { event: 'hydrate', foldId, hydrations, originAge: found.entry.originAge, ...(anchor ? { anchor } : {}) });
    const note = pinned
      ? `\n\n[origami: ${foldId} has now been hydrated ${hydrations}× and is pinned — it will be restored inline and stay open. Call unpin("${foldId}") if that stops being useful.]`
      : found.entry.state === 'evicted'
        ? `\n\n[origami: ${foldId} is evicted — its stub is no longer in the conversation, so it will not be restored inline. The content above is still the full stored body.]`
        : '';
    // F9: the pin notice rides at BOTH ends. A large body may be preview-truncated
    // (head only) in the model's view, so a tail-only notice can be lost entirely.
    const lead = pinned ? note.trimStart() + '\n\n' : '';
    return lead + (found.header ? found.header + '\n\n' : '') + found.body + note;
  } catch (err) {
    return `origami could not hydrate "${foldId}": ${err instanceof Error ? err.message : String(err)}. The stored body may have been removed; re-run the original tool if you need the content.`;
  }
}

export async function handleUnpin($: EngineInterface, foldId: string): Promise<string> {
  try {
    const io = await storeIO($);
    const found = await getFold(io, foldId);
    if (!found) return `Unknown fold id "${foldId}".`;
    await setFold(io, { ...found.entry, state: 'folded', hydrations: 0 });
    await appendLog(io, { event: 'unpin', foldId });
    return `${foldId} unpinned: it is fold-eligible again and will refold on the next sweep.`;
  } catch (err) {
    return `origami could not unpin "${foldId}": ${err instanceof Error ? err.message : String(err)}.`;
  }
}

// The degradation health metric (spec addendum): a tool call whose target matches
// a live fold means the model re-ran a tool instead of hydrating. Observe-only.
export async function observeMissedHydrate(
  $: EngineInterface, call: { tool: string; input: Record<string, unknown> },
): Promise<void> {
  try {
    if (call.tool !== 'Read') return; // v1 watches the highest-signal case only
    const io = await storeIO($);
    const key = inputKeyOf(call.input);
    const match = (await allFolds(io)).find(f => f.state === 'folded' && f.tool === 'Read' && f.inputKey === key);
    if (match) await appendLog(io, { event: 'missed_hydrate', foldId: match.id, tool: call.tool, inputKey: key });
  } catch { /* observation must never break a tool call */ }
}

// The standing session-start notice: independent of the sweep-time banner, which
// only exists once a first sweep has folded something. It kills the pre-first-sweep
// confusion ("no banner — is the hook misplaced?") and pre-arms the model against
// discovering mid-session that its context changed shape.
export const SESSION_NOTICE = '[origami is active in this session (BETA). Your context is a RENDERING that origami may rewrite between turns: bulky older tool results can be folded away to disk and replaced with [origami fold-…] stubs, and can return. Once folds exist, a status banner appears at the very top of the context. Nothing is ever lost — folded content is recoverable via the hydrate tool. If the context seems to have changed shape between turns, it has; your own earlier messages are your record of what you saw.]';

export const register: Register = (on, options) => {
  const config = readConfig(options);
  let sweeping = false;
  on('turn.complete', async ($, e, next) => {
    if ((e as { agentId?: string }).agentId) return next(e);   // main thread only
    if (!sweeping) {
      try {
        const d = await shouldSweep($, config);
        if (d.sweep) {
          sweeping = true;
          await (await storeIO($)).storeSet(AGGRESSIVE, d.aggressive);
          await $.session.compact();          // rejects while a turn runs → caught below
        }
      } catch (err) {
        $.ui.log(`origami trigger skipped: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        sweeping = false;
      }
    }
    return next(e);
  });
  on('session.compact', async ($, e, next) => {
    const result = await runSweep($, config, e);
    if (result) return result;
    // F10, `auto` row: origami must never block an auto compaction (the window is
    // genuinely full), but it can make the stock summarizer's INPUT carry the fold
    // index, so the recovery links have explicit list-shaped material to survive in.
    // Only the main thread has folds; subagents and precompute pass through bare.
    if (e.trigger === 'auto' && !e.agentId) {
      try {
        const index = foldIndexMessage(await allFolds(await storeIO($)));
        if (index) return next({ ...e, messages: [...e.messages, index] });
      } catch { /* insurance is best-effort: never block the compaction it protects */ }
    }
    return next(e);
  });
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'hydrate',
      description: 'Expand an origami fold to its full stored content. Use before re-running a tool whose result was folded — re-running may not reproduce it (files change, tests flake). fold_id appears in [origami fold-…] stubs and in hydrate:// links; when a specific link motivated this call, pass its #fragment as anchor.',
      inputSchema: { type: 'object', properties: { fold_id: { type: 'string' }, anchor: { type: 'string' } }, required: ['fold_id'] },
    });
    await $.tool.register({
      name: 'unpin',
      description: 'Release a pinned origami fold so it can fold again. Use when pinned content is no longer earning its place in context.',
      inputSchema: { type: 'object', properties: { fold_id: { type: 'string' } }, required: ['fold_id'] },
    });
    return next(e);
  });
  // The standing session-start notice (spec addendum). `session.start`'s own result
  // is `{ cwd }` and nothing else (types/claude-code.d.ts :9031-9036 — "a hook's own
  // value does not change the session"), so it cannot carry model-visible text. The
  // SAME session-start event in its classic form can: ClassicResultFields.SessionStart
  // lists 'additionalContext' (:1063), handed to the model with the event (:991-994).
  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e);
    return { ...result, additionalContext: [...(result.additionalContext ?? []), SESSION_NOTICE] };
  });
  // Serve the two declared tools: a tool.call hook must answer with `{ result }`
  // (core sets `text` for the model from it; a hook's own `{ text }` is not read —
  // see ToolCallResult in types/claude-code.d.ts). Both tools' arguments ride
  // flat on `e` (McpToolCallInputFallback's `[argument: string]: unknown`), not
  // nested under an `input` key.
  on('tool.call', { tool: 'mcp__origami__hydrate' }, async ($, e) => {
    const input = e as unknown as { fold_id?: unknown; anchor?: unknown };
    return { result: await handleHydrate($, config, String(input.fold_id ?? ''), typeof input.anchor === 'string' ? input.anchor : undefined) };
  });
  on('tool.call', { tool: 'mcp__origami__unpin' }, async ($, e) => {
    const input = e as unknown as { fold_id?: unknown };
    return { result: await handleUnpin($, String(input.fold_id ?? '')) };
  });
  on('tool.call', async ($, e, next) => {
    // observe-only middleware: never blocks, never rewrites; main thread only
    const call = e as unknown as { tool: string; agentId?: string; [k: string]: unknown };
    if (!call.agentId && call.tool === 'Read') {
      await observeMissedHydrate($, { tool: call.tool, input: call as unknown as Record<string, unknown> });
    }
    return next(e);
  });
};
