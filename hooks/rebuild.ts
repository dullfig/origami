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
