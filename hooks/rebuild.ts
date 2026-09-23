import type { SessionMessage } from 'claude-code';
import type { OrigamiConfig } from './origami';

const MIN_CANDIDATE_TOKENS = 256; // below this a fold saves nothing worth a stub

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// FNV-1a over the text, base36 — the same construction as origami.ts's projectHash,
// which hashes the project root. It lives HERE rather than in origami.ts because the
// $-rule confines origami.ts to top-level functions the validator can follow $ into;
// a pure helper needed by store-facing code belongs in a dependency-free module.
// Not cryptographic and not meant to be: it fingerprints a tool result so a keep
// verdict can be invalidated if the same tool_use_id ever carries different text.
// The length is mixed in so a collision needs matching length AND matching digest.
export function contentHash(text: string): string {
  let h = 0x811c9dc5;                                   // FNV-1a, 32-bit
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${text.length.toString(36)}-${h.toString(36)}`;
}

// The synthetic sweep-marker user message's fixed text prefix (v1.1 item 6). Shared
// by sweepMarkerPair (which writes it) and turnAges (which must not count it as a
// turn start — it is inserted between real turns, not spoken by the user).
export const MARKER_PREFIX = '[origami sweep report:';

export function turnAges(messages: readonly SessionMessage[]): number[] {
  const turnOf: number[] = [];
  let turn = -1;
  for (const m of messages) {
    if (m.role === 'user' && m.text.trim() !== '' && !m.text.startsWith(MARKER_PREFIX)) turn += 1;
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

// Every fold id whose stub actually appears in the transcript (message text or a tool
// result). Used to reconcile the fold index: an entry in state 'folded' whose stub is
// gone no longer exists as far as the conversation is concerned.
//
// v1.1 item 6 verification: the pattern requires the literal stub prefix `[origami `
// immediately followed by `fold-NNN` — a bare mention of a fold id elsewhere in text
// (e.g. inside a sweepMarkerPair marker, which lists ids like "folded fold-013" without
// the `[origami ` prefix directly before them) does NOT match. Confirmed with a test
// (rebuild.test.ts) rather than changed: this was already the correct, tight matcher.
export function foldIdsPresent(messages: readonly SessionMessage[]): Set<string> {
  const out = new Set<string>();
  const scan = (text: string) => {
    for (const m of text.matchAll(/\[origami (fold-\d+)[\s·]/g)) out.add(m[1]);
  };
  for (const m of messages) {
    scan(m.text);
    for (const r of m.toolResults ?? []) scan(r.text);
  }
  return out;
}

// --- Sweep marker (v1.1 item 6, banner split) ---
// A small handle-less user+assistant pair appended at the tail of the rebuilt
// messages on every SUCCESSFUL sweep. Unlike the banner (static, written once,
// rules only), the marker is mutable status written fresh each sweep and left in
// place forever after — historically true at its position in the transcript.
//
// CRITICAL: the text must never contain the substring `[origami fold-` (the stub
// prefix) — fold ids are written bare so foldIdsPresent (which anchors on that
// exact prefix) never mistakes a marker mention for a live stub.
export function sweepMarkerPair(report: {
  foldedIds: readonly string[]; restoredIds: readonly string[]; activeFolds: number;
  staleIds?: readonly string[];
}): SessionMessage[] {
  // Fold ids stay BARE (no `[origami fold-` prefix) so foldIdsPresent never mistakes
  // this marker's mentions for live stubs — the same rule the folded/restored lists follow.
  const stale = report.staleIds && report.staleIds.length
    ? ` Now STALE (source edited since capture): ${report.staleIds.join(', ')} — hydrate to see the snapshot plus a pointer to re-read the current file.`
    : '';
  // Self-announcing preamble (v1.1.1 legibility): runSweep only ever emits this marker on
  // a summary-replacing sweep (plugin/manual triggers; auto and precompute never reach
  // here), so it can state plainly that this rebuild stands IN PLACE of the stock
  // compaction summary. Without it, a knowledge-free agent sees a compaction with no
  // summary and cannot tell whether origami worked or the hooks reset — the exact
  // confusion observed in a live smoke session.
  const text = `${MARKER_PREFIX} this is origami's in-place rebuild of the context — not a stock compaction summary; nothing was lost, earlier turns remain, and any that were folded now render as origami stubs. This sweep folded ${report.foldedIds.join(', ') || 'nothing'}; restored ${report.restoredIds.join(', ') || 'nothing'}; ${report.activeFolds} folds now active.${stale} Content discussed above this point may now render as stubs — hydrate to recover it.]`;
  return [
    { role: 'user', text, toolUses: [] },
    { role: 'assistant', text: 'Noted. [synthetic acknowledgment inserted by origami]', toolUses: [] },
  ];
}

// --- Fold-index insurance (spec addendum F10, `auto` row) ---
// When origami cannot reduce an `auto` compaction, the stock summarizer runs and
// would otherwise wipe every stub. This handle-less user message is appended to
// the event handed to next(), so the summarizer's input carries an explicit,
// list-shaped inventory of the live folds to preserve the recovery links from.
// Pure: takes store entries, returns undefined when no fold is live.
export function foldIndexMessage(folds: readonly FoldIndexEntry[]): SessionMessage | undefined {
  const live = folds.filter(f => f.state === 'folded' || f.state === 'pinned');
  if (live.length === 0) return undefined;
  const lines = live.map(f => `${f.id} — ${f.stub}`).join('\n');
  return {
    role: 'user',
    text: `[origami fold index — preserve these recovery links in any summary]\n${lines}`,
    toolUses: [],
    // no handle: synthetic
  };
}

// The shape foldIndexMessage needs of a store entry (structurally satisfied by
// store.ts's FoldEntry; declared here so rebuild.ts stays dependency-free).
export type FoldIndexEntry = { id: string; stub: string; state: 'folded' | 'pinned' | 'evicted' };

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

// v1.1 item 6 (banner split): STATIC — rules only, no fold count. Written once at
// the first sweep and never rewritten afterward (the point: index 0/1 then keep
// their handles and their place in the prompt cache across every later sweep).
// The mutable status moved inline — see sweepMarkerPair.
export function bannerText(version: string): string {
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
- Statements you made before a fold were made with the full content in
  view; your own earlier messages are your record of what you saw.
  Distrust only claims sourced from a stub alone.
- Do not be confused when the conversation below discusses content that
  now shows only as a stub: the conversation is rewritten in place, and
  that content was fully visible when those messages were written. It is
  not a contradiction, and nobody misspoke.
This notice is written once; per-sweep reports appear inline in the conversation below.]`;
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
