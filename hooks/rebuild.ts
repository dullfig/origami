import type { SessionMessage } from 'claude-code';
import type { OrigamiConfig } from './origami';

const MIN_CANDIDATE_TOKENS = 256; // below this a fold saves nothing worth a stub

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function turnAges(messages: readonly SessionMessage[]): number[] {
  const turnOf: number[] = [];
  let turn = -1;
  for (const m of messages) {
    if (m.role === 'user' && m.text.trim() !== '') turn += 1;
    turnOf.push(Math.max(turn, 0));
  }
  const newest = Math.max(turn, 0);
  return turnOf.map(t => newest - t);
}

export type Candidate = {
  messageIndex: number;
  resultIndex: number;
  toolUseId: string;
  tool: string;
  input: Record<string, unknown>;
  text: string;
  sizeTokens: number;
  ageTurns: number;
};

export function selectCandidates(
  messages: readonly SessionMessage[],
  excludedToolUseIds: ReadonlySet<string>,
  cfg: OrigamiConfig,
  aggressive: boolean,
): Candidate[] {
  const ages = turnAges(messages);
  const minAge = Math.max(aggressive ? 1 : cfg.foldAgeTurns, 1);
  const toolByUseId = new Map<string, { tool: string; input: Record<string, unknown> }>();
  for (const m of messages) {
    for (const u of m.toolUses) toolByUseId.set(u.tool_use_id, { tool: u.tool, input: u.input });
  }
  const out: Candidate[] = [];
  messages.forEach((m, mi) => {
    if (mi === 0) return; // first message is pinned by invariant
    (m.toolResults ?? []).forEach((r, ri) => {
      if (excludedToolUseIds.has(r.tool_use_id)) return;
      if (ages[mi] < minAge) return;
      const sizeTokens = estimateTokens(r.text);
      if (sizeTokens < MIN_CANDIDATE_TOKENS) return;
      const call = toolByUseId.get(r.tool_use_id);
      out.push({
        messageIndex: mi, resultIndex: ri, toolUseId: r.tool_use_id,
        tool: call?.tool ?? 'unknown', input: call?.input ?? {},
        text: r.text, sizeTokens, ageTurns: ages[mi],
      });
    });
  });
  return out;
}

export function candidateMass(candidates: readonly Candidate[]): number {
  return candidates.reduce((sum, c) => sum + c.sizeTokens, 0);
}

export type FoldDecision = { toolUseId: string; foldId: string; stub: string };
export type RestoreDecision = { toolUseId: string; foldId: string; body: string };

export function stubText(foldId: string, tool: string, stub: string): string {
  return `[origami ${foldId} · ${tool} result folded] ${stub} — call hydrate("${foldId}") for the full content.`;
}

export type RebuildOutcome =
  | { kind: 'rebuilt'; messages: SessionMessage[]; tokensBefore: number; tokensAfter: number }
  | { kind: 'insufficient'; ratio: number };

export function rebuild(
  messages: readonly SessionMessage[],
  folds: readonly FoldDecision[],
  restores: readonly RestoreDecision[],
  cfg: OrigamiConfig,
  aggressive = false,
): RebuildOutcome {
  const protectedTurns = aggressive ? 1 : cfg.preserveRecentTurns;
  const ages = turnAges(messages);
  const foldByUseId = new Map(folds.map(f => [f.toolUseId, f]));
  const restoreByUseId = new Map(restores.map(r => [r.toolUseId, r]));
  const toolByUseId = new Map<string, string>();
  for (const mm of messages) for (const u of mm.toolUses) toolByUseId.set(u.tool_use_id, u.tool);
  const massOf = (ms: readonly SessionMessage[]) =>
    ms.reduce((s, m) => s + estimateTokens(m.text)
      + (m.toolResults ?? []).reduce((a, r) => a + estimateTokens(r.text), 0)
      + m.toolUses.reduce((a, u) => a + estimateTokens(JSON.stringify(u.input)), 0), 0);
  const tokensBefore = massOf(messages);

  const out: SessionMessage[] = messages.map((m, mi) => {
    const results = m.toolResults ?? [];
    const touched = results.some(r => foldByUseId.has(r.tool_use_id) || restoreByUseId.has(r.tool_use_id));
    if (!touched) return m as SessionMessage;
    if (mi === 0) throw new Error('origami invariant: first message is pinned');
    if (ages[mi] < protectedTurns) {
      throw new Error(`origami invariant: decision targets a message inside the protected recent turns (age ${ages[mi]})`);
    }
    return {
      role: m.role,
      text: m.text,
      toolUses: m.toolUses,
      toolResults: results.map(r => {
        const f = foldByUseId.get(r.tool_use_id);
        if (f) return { tool_use_id: r.tool_use_id, text: stubText(f.foldId, toolByUseId.get(r.tool_use_id) ?? 'tool', f.stub), isError: r.isError };
        const p = restoreByUseId.get(r.tool_use_id);
        if (p) return { tool_use_id: r.tool_use_id, text: p.body, isError: r.isError };
        return r;
      }),
      // no handle: this message is rebuilt
    };
  });

  const tokensAfter = massOf(out);
  const ratio = tokensBefore > 0 ? (tokensBefore - tokensAfter) / tokensBefore : 0;
  const restoring = restores.length > 0; // reopening pins may legitimately grow the context
  if (!restoring && ratio < cfg.minReductionRatio) return { kind: 'insufficient', ratio };
  return { kind: 'rebuilt', messages: out, tokensBefore, tokensAfter };
}

// --- Banner ---
// A standalone synthetic user+assistant pair prepended at the very top of the
// transcript so role alternation is preserved and no real message text is ever
// edited. Rebuilt fresh every sweep: stripBanner() first, then applyBanner().

export const BANNER_PREFIX = '[ORIGAMI v';

export function bannerText(version: string, activeFolds: number): string {
  return `[ORIGAMI v${version} — BETA. This session's older tool results have been FOLDED:
replaced by short link-stubs written by a librarian that read the full
content. The full content is intact on disk — nothing is lost.
- A [linked phrase](hydrate://fold-NNN) is a fold. Follow it with the
  hydrate tool BEFORE re-running a tool or concluding you never saw
  something.
- Never state details of folded content from the stub alone — hydrate
  first. A stub is an advertisement, not the artifact.
- BETA DUTY: if you notice a reference to content you cannot locate, a
  stub that contradicts your memory, or anything that feels like a gap —
  SAY SO TO THE USER explicitly. You are a test pilot; anomalies are data.
Currently ${activeFolds} folds active.]`;
}

export const BANNER_ACK = "Understood — I'll follow hydrate:// links before re-running tools or claiming I never saw something, and I'll flag anomalies to the user. [synthetic acknowledgment inserted by origami]";

// Removes an existing banner pair if present: a user message whose text starts
// with BANNER_PREFIX at index 0, plus the immediately following assistant
// message when its text === BANNER_ACK. Returns a new array; input untouched.
export function stripBanner(messages: readonly SessionMessage[]): SessionMessage[] {
  const first = messages[0];
  const second = messages[1];
  if (first && first.role === 'user' && first.text.startsWith(BANNER_PREFIX)
    && second && second.role === 'assistant' && second.text === BANNER_ACK) {
    return messages.slice(2);
  }
  return messages.slice();
}

// Prepends a fresh banner pair: [{role:'user', text: banner, toolUses: []},
// {role:'assistant', text: BANNER_ACK, toolUses: []}] — both handle-less
// (synthetic, rebuilt every sweep). Does NOT strip; callers strip first.
export function applyBanner(messages: readonly SessionMessage[], banner: string): SessionMessage[] {
  return [
    { role: 'user', text: banner, toolUses: [] },
    { role: 'assistant', text: BANNER_ACK, toolUses: [] },
    ...messages,
  ];
}
