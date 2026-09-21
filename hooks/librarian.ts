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
// turns a routine sweep into a probabilistic outage. An UNKNOWN id in the reply (the
// model naming something that was never offered — typically one transcribed character
// wrong out of dozens of long random ids) is ALSO not a failure: `decisions` is built
// by mapping over `expectedIds`, never by trusting whatever the reply names, so an
// unknown entry has no path into `decisions` and cannot be consulted or corrupt
// anything — it is simply dropped. A typo'd id therefore shows up as exactly one
// unknown (the garbled name) plus one defaulted (its intended twin, now unanswered),
// and the sweep degrades to keep+cooldown for that one candidate — safe, not fatal.
export function parseSweepReply(
  reply: string, expectedIds: readonly string[],
): { decisions: LibrarianDecision[]; defaulted: string[]; unknown: string[] } {
  const re = /<decision id="([^"]+)" action="(keep|fold)">([\s\S]*?)<\/decision>/g;
  const found = new Map<string, LibrarianDecision>();
  for (let m = re.exec(reply); m !== null; m = re.exec(reply)) {
    found.set(m[1], { toolUseId: m[1], action: m[2] as 'keep' | 'fold', stub: m[3].trim() });
  }
  const unknown = [...found.keys()].filter(id => !expectedIds.includes(id));
  const defaulted: string[] = [];
  const decisions = expectedIds.map(id => {
    const d = found.get(id);
    if (d) return d;
    defaulted.push(id);
    return { toolUseId: id, action: 'keep' as const, stub: '' };
  });
  return { decisions, defaulted, unknown };
}

// A sweep's wall time is one serial librarian prefill over every candidate. Splitting
// the offer into batches and running them concurrently turns that into the slowest
// single batch. Batching is the GENERAL path: with <= LIBRARIAN_BATCH_SIZE candidates
// there is exactly one batch, so the single-call behaviour is unchanged (one prompt,
// one complete call, the same maxTokens scaling).
//
// A batch also contains the blast radius of an omission: parseSweepReply defaults a
// missing id to 'keep', and because each batch is parsed against ITS OWN expectedIds,
// a reply that drops everything defaults only its own candidates — the other batches'
// decisions are unaffected.
export const LIBRARIAN_BATCH_SIZE = 15;

export async function runLibrarian(
  complete: CompleteFn, model: string, candidates: readonly Candidate[], aggressive: boolean,
): Promise<{ decisions: LibrarianDecision[]; defaulted: string[]; unknown: string[]; inputTokens: number; outputTokens: number }> {
  const batches: Candidate[][] = [];
  for (let i = 0; i < candidates.length; i += LIBRARIAN_BATCH_SIZE) {
    batches.push(candidates.slice(i, i + LIBRARIAN_BATCH_SIZE));
  }
  const runs = await Promise.all(batches.map(async (batch) => {
    const prompt = buildSweepPrompt(batch, aggressive);
    const maxTokens = Math.min(16384, 1024 + batch.length * 128);
    const reply = await complete({ model, prompt, maxTokens });
    const parsed = parseSweepReply(reply, batch.map(c => c.toolUseId));
    return { ...parsed, inputTokens: estimateTokens(prompt), outputTokens: estimateTokens(reply) };
  }));
  // Batches are contiguous, in-order slices, so flattening restores the caller's own
  // candidate order — `decisions` stays aligned with `candidates` exactly as the
  // single-call path produced it.
  return {
    decisions: runs.flatMap(r => r.decisions),
    defaulted: runs.flatMap(r => r.defaulted),
    unknown: runs.flatMap(r => r.unknown),
    inputTokens: runs.reduce((s, r) => s + r.inputTokens, 0),
    outputTokens: runs.reduce((s, r) => s + r.outputTokens, 0),
  };
}
