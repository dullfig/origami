import type { Register, EngineInterface, SessionCompactInput, SessionCompactResult, SessionMessage } from 'claude-code';
import { selectCandidates, rebuild, bannerText, stripBanner, applyBanner, type FoldDecision, type RestoreDecision, candidateMass, estimateTokens } from './rebuild';
import { runLibrarian, type CompleteFn } from './librarian';
import { newFoldId, putFold, getFold, setFold, allFolds, appendLog, inputKeyOf, type FoldEntry, type StoreIO } from './store';

// SAME-FILE closures over $: the engine validator follows $ only into functions
// declared in this file, never across an import, so these adapters must live here
// and be built at each hook call site before crossing into store.ts/librarian.ts.
function storeIO($: EngineInterface): StoreIO {
  return {
    fsRead: async (path) => String(await $.fs.read(path)),
    fsWrite: (path, text) => $.fs.write(path, text),
    fsExists: (path) => $.fs.exists(path),
    storeGet: (key) => $.store.get(key),
    storeSet: (key, value) => $.store.set(key, value),
    storeKeys: () => $.store.keys(),
  };
}
function completeWith($: EngineInterface): CompleteFn {
  return (req) => $.model.complete(req);
}

// Keep in sync with .claude-plugin/plugin.json's "version".
export const ORIGAMI_VERSION = '1.0.0';

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

export async function shouldSweep(
  $: EngineInterface, cfg: OrigamiConfig, messagesArg?: readonly SessionMessage[],
): Promise<{ sweep: boolean; aggressive: boolean }> {
  const messages = messagesArg ?? await $.session.messages();
  const liveTokens = messages.reduce((s, m) => s + estimateTokens(m.text)
    + (m.toolResults ?? []).reduce((a, r) => a + estimateTokens(r.text), 0), 0);
  const aggressive = liveTokens > cfg.workingSetBudget;
  const mass = candidateMass(
    selectCandidates(messages, new Set<string>(), cfg, aggressive)
      .filter(c => !c.text.startsWith('[origami fold-')),
  );
  return { sweep: mass >= cfg.minFoldMass || (aggressive && mass > 0), aggressive };
}

// returns a result to answer with, or undefined = caller must pass through via next(e)
export async function runSweep(
  $: EngineInterface, cfg: OrigamiConfig, e: Pick<SessionCompactInput, 'trigger' | 'agentId' | 'messages'>,
): Promise<SessionCompactResult | undefined> {
  if (e.agentId) return undefined;                       // main thread only
  if (e.trigger === 'precompute') return undefined;      // out of scope v1
  try {
    const io = storeIO($);
    // strip any existing banner pair first: all subsequent logic runs on the
    // stripped array, never on e.messages directly
    const messages = stripBanner(e.messages);
    const folds = await allFolds(io);
    // pinned folds stay open: once restored inline their big results must never
    // become candidates again, so exclusion is by the toolUseId the entry recorded
    const excluded = new Set(folds.filter(f => f.state === 'pinned').map(f => f.toolUseId));
    const aggressive = Boolean(await $.store.get('origami:aggressive'));
    const candidates = selectCandidates(messages, excluded, cfg, aggressive)
      .filter(c => !c.text.startsWith('[origami fold-'));  // never re-fold a stub
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
    if (candidates.length === 0 && restores.length === 0) {
      return e.trigger === 'plugin' ? { skip: 'origami: nothing to fold' } : undefined;
    }
    const lib = candidates.length > 0
      ? await runLibrarian(completeWith($), cfg.librarianModel, candidates, aggressive)
      : { decisions: [], inputTokens: 0, outputTokens: 0 };
    const foldDecisions: FoldDecision[] = [];
    for (const d of lib.decisions) {
      if (d.action !== 'fold') continue;
      const c = candidates.find(x => x.toolUseId === d.toolUseId)!;
      const id = await newFoldId(io);
      const stub = d.stub.replaceAll('hydrate://FOLD#', `hydrate://${id}#`); // librarian writes the FOLD token; the real id lands here
      const entry: FoldEntry = { id, stub, state: 'folded', tool: c.tool, toolUseId: c.toolUseId, inputKey: inputKeyOf(c.input), originAge: c.ageTurns, sizeTokens: c.sizeTokens, hydrations: 0 };
      await putFold(io, entry, `# ${id} · ${c.tool} ${JSON.stringify(c.input)}\n\n${c.text}`);
      foldDecisions.push({ toolUseId: d.toolUseId, foldId: id, stub });
    }
    const outcome = rebuild(messages, foldDecisions, restores, cfg, aggressive);
    if (outcome.kind === 'insufficient') {
      return e.trigger === 'plugin' ? { skip: `origami: reduction ${outcome.ratio.toFixed(2)} below threshold` } : undefined;
    }
    await $.store.set('origami:aggressive', false);
    const activeFolds = (await allFolds(io)).filter(f => f.state === 'folded').length;
    const finalMessages = applyBanner(outcome.messages, bannerText(ORIGAMI_VERSION, activeFolds));
    await appendLog(io, {
      event: 'sweep', trigger: e.trigger, aggressive,
      tokensBefore: outcome.tokensBefore, tokensAfter: outcome.tokensAfter,
      librarianInputTokens: lib.inputTokens, librarianOutputTokens: lib.outputTokens,
      foldsCreated: foldDecisions.length, restores: restores.length, foldsActive: activeFolds,
    });
    return { messages: finalMessages, tokensBefore: outcome.tokensBefore, tokensAfter: outcome.tokensAfter };
  } catch (err) {
    $.ui.log(`origami sweep failed, falling back: ${err instanceof Error ? err.message : String(err)}`);
    return e.trigger === 'plugin' ? { skip: 'origami: sweep failed' } : undefined;
  }
}

export async function handleHydrate($: EngineInterface, cfg: OrigamiConfig, foldId: string, anchor?: string): Promise<string> {
  const io = storeIO($);
  const found = await getFold(io, foldId);
  if (!found) return `Unknown fold id "${foldId}". Fold ids look like fold-001 and appear in [origami fold-…] stubs in the conversation.`;
  const hydrations = found.entry.hydrations + 1;
  const pinned = hydrations >= cfg.pinAfterHydrations && found.entry.state !== 'pinned';
  await setFold(io, { ...found.entry, hydrations, state: pinned ? 'pinned' : found.entry.state });
  await appendLog(io, { event: 'hydrate', foldId, hydrations, originAge: found.entry.originAge, ...(anchor ? { anchor } : {}) });
  const note = pinned
    ? `\n\n[origami: ${foldId} has now been hydrated ${hydrations}× and is pinned — it will be restored inline and stay open. Call unpin("${foldId}") if that stops being useful.]`
    : '';
  return found.body + note;
}

export async function handleUnpin($: EngineInterface, foldId: string): Promise<string> {
  const io = storeIO($);
  const found = await getFold(io, foldId);
  if (!found) return `Unknown fold id "${foldId}".`;
  await setFold(io, { ...found.entry, state: 'folded', hydrations: 0 });
  await appendLog(io, { event: 'unpin', foldId });
  return `${foldId} unpinned: it is fold-eligible again and will refold on the next sweep.`;
}

// The degradation health metric (spec addendum): a tool call whose target matches
// a live fold means the model re-ran a tool instead of hydrating. Observe-only.
export async function observeMissedHydrate(
  $: EngineInterface, call: { tool: string; input: Record<string, unknown> },
): Promise<void> {
  try {
    if (call.tool !== 'Read') return; // v1 watches the highest-signal case only
    const io = storeIO($);
    const key = inputKeyOf(call.input);
    const match = (await allFolds(io)).find(f => f.state === 'folded' && f.tool === 'Read' && f.inputKey === key);
    if (match) await appendLog(io, { event: 'missed_hydrate', foldId: match.id, tool: call.tool, inputKey: key });
  } catch { /* observation must never break a tool call */ }
}

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
          await $.store.set('origami:aggressive', d.aggressive);
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
    return result ?? next(e);
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
