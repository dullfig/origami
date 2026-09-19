import type { Register, EngineInterface, SessionCompactInput, SessionCompactResult, SessionMessage } from 'claude-code';
import { selectCandidates, rebuild, bannerText, stripBanner, applyBanner, type FoldDecision, type RestoreDecision, candidateMass, estimateTokens } from './rebuild';
import { runLibrarian } from './librarian';
import { newFoldId, putFold, getFold, allFolds, appendLog, inputKeyOf, type FoldEntry } from './store';

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
    // strip any existing banner pair first: all subsequent logic runs on the
    // stripped array, never on e.messages directly
    const messages = stripBanner(e.messages);
    const folds = await allFolds($);
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
            const stored = await getFold($, f.id);
            if (stored) restores.push({ toolUseId: r.tool_use_id, foldId: f.id, body: stored.body });
          }
        }
      }
    }
    if (candidates.length === 0 && restores.length === 0) {
      return e.trigger === 'plugin' ? { skip: 'origami: nothing to fold' } : undefined;
    }
    const lib = candidates.length > 0
      ? await runLibrarian($, cfg.librarianModel, candidates, aggressive)
      : { decisions: [], inputTokens: 0, outputTokens: 0 };
    const foldDecisions: FoldDecision[] = [];
    for (const d of lib.decisions) {
      if (d.action !== 'fold') continue;
      const c = candidates.find(x => x.toolUseId === d.toolUseId)!;
      const id = await newFoldId($);
      const stub = d.stub.replaceAll('hydrate://FOLD#', `hydrate://${id}#`); // librarian writes the FOLD token; the real id lands here
      const entry: FoldEntry = { id, stub, state: 'folded', tool: c.tool, toolUseId: c.toolUseId, inputKey: inputKeyOf(c.input), originAge: c.ageTurns, sizeTokens: c.sizeTokens, hydrations: 0 };
      await putFold($, entry, `# ${id} · ${c.tool} ${JSON.stringify(c.input)}\n\n${c.text}`);
      foldDecisions.push({ toolUseId: d.toolUseId, foldId: id, stub });
    }
    const outcome = rebuild(messages, foldDecisions, restores, cfg, aggressive);
    if (outcome.kind === 'insufficient') {
      return e.trigger === 'plugin' ? { skip: `origami: reduction ${outcome.ratio.toFixed(2)} below threshold` } : undefined;
    }
    await $.store.set('origami:aggressive', false);
    const activeFolds = (await allFolds($)).filter(f => f.state === 'folded').length;
    const finalMessages = applyBanner(outcome.messages, bannerText(ORIGAMI_VERSION, activeFolds));
    await appendLog($, {
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
};
