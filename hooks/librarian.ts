import { estimateTokens, type Candidate } from './rebuild';

export type LibrarianDecision = { toolUseId: string; action: 'keep' | 'fold'; stub: string };

export type CompleteFn = (req: { model: string; prompt: string; maxTokens?: number }) => Promise<string>;

export function buildSweepPrompt(candidates: readonly Candidate[], aggressive: boolean): string {
  const head = [
    'You are the librarian of a coding session. Each <candidate> below is a stale tool result',
    'still occupying the live context. For each one decide:',
    '  keep — its exact content is likely needed verbatim again soon;',
    '  fold — a short stub suffices; full content stays recoverable on demand.',
    aggressive ? 'The working set is over budget: fold everything not clearly needed.' : '',
    'For EVERY candidate answer exactly one line:',
    '<decision id="ID" action="keep|fold">stub</decision>',
    'A stub is anchor text, not a note: name what it is, then 2-4 concept-level markdown links',
    'to the most load-bearing things inside, grammar [concept](hydrate://FOLD#slug), where FOLD',
    'is the literal token FOLD (replaced with the real fold id later) and #slug names the concept.',
    'Example: src/auth.ts (480 lines): [JWT validation](hydrate://FOLD#jwt), [refresh flow](hydrate://FOLD#refresh), [SECRET_ROTATION](hydrate://FOLD#rotation)',
    'Write anchors from the content you see. No other output.',
  ].filter(Boolean).join('\n');
  const body = candidates.map(c =>
    `<candidate id="${c.toolUseId}" tool="${c.tool}" input=${JSON.stringify(JSON.stringify(c.input))} age_turns="${c.ageTurns}">\n${c.text}\n</candidate>`
  ).join('\n');
  return `${head}\n\n${body}`;
}

// A candidate the librarian's reply is silent on (or answers with a malformed block)
// is NOT a failure: 'keep' is safe by construction — the content simply stays inline,
// same as if the sweep had never picked it up. With N candidates the probability of
// at least one omission grows with N, so on large sessions treating a miss as fatal
// turns a routine sweep into a probabilistic outage. An UNKNOWN id in the reply is a
// different failure class (the model naming something that was never offered) and
// still throws — that is a hallucination, not an omission, and has no safe default.
export function parseSweepReply(
  reply: string, expectedIds: readonly string[],
): { decisions: LibrarianDecision[]; defaulted: string[] } {
  const re = /<decision id="([^"]+)" action="(keep|fold)">([\s\S]*?)<\/decision>/g;
  const found = new Map<string, LibrarianDecision>();
  for (let m = re.exec(reply); m !== null; m = re.exec(reply)) {
    found.set(m[1], { toolUseId: m[1], action: m[2] as 'keep' | 'fold', stub: m[3].trim() });
  }
  for (const id of found.keys()) if (!expectedIds.includes(id)) throw new Error(`librarian reply names unknown id ${id}`);
  const defaulted: string[] = [];
  const decisions = expectedIds.map(id => {
    const d = found.get(id);
    if (d) return d;
    defaulted.push(id);
    return { toolUseId: id, action: 'keep' as const, stub: '' };
  });
  return { decisions, defaulted };
}

export async function runLibrarian(
  complete: CompleteFn, model: string, candidates: readonly Candidate[], aggressive: boolean,
): Promise<{ decisions: LibrarianDecision[]; defaulted: string[]; inputTokens: number; outputTokens: number }> {
  const prompt = buildSweepPrompt(candidates, aggressive);
  const maxTokens = Math.min(16384, 1024 + candidates.length * 128);
  const reply = await complete({ model, prompt, maxTokens });
  const { decisions, defaulted } = parseSweepReply(reply, candidates.map(c => c.toolUseId));
  return { decisions, defaulted, inputTokens: estimateTokens(prompt), outputTokens: estimateTokens(reply) };
}
