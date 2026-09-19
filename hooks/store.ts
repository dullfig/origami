import type { EngineInterface } from 'claude-code';

export type FoldEntry = {
  id: string; stub: string; state: 'folded' | 'pinned';
  tool: string; toolUseId: string; inputKey: string;
  originAge: number; sizeTokens: number; hydrations: number;
};

export function inputKeyOf(input: Record<string, unknown>): string {
  return typeof input.file_path === 'string' ? input.file_path : JSON.stringify(input);
}

const SEQ = 'origami:seq';
const FOLD = (id: string) => `origami:fold:${id}`;
const BODY = (id: string) => `.claude/origami/folds/${id}.md`;
const LOG = '.claude/origami/origami.log';

export async function newFoldId($: EngineInterface): Promise<string> {
  const n = Number((await $.store.get(SEQ)) ?? 0) + 1;
  await $.store.set(SEQ, n);
  return `fold-${String(n).padStart(3, '0')}`;
}

export async function putFold($: EngineInterface, entry: FoldEntry, body: string): Promise<void> {
  await $.fs.write(BODY(entry.id), body);
  await $.store.set(FOLD(entry.id), entry);
}

export async function getFold($: EngineInterface, id: string): Promise<{ entry: FoldEntry; body: string } | undefined> {
  const entry = (await $.store.get(FOLD(id))) as FoldEntry | undefined;
  if (!entry) return undefined;
  const body = String(await $.fs.read(BODY(id)));
  return { entry, body };
}

export async function setFold($: EngineInterface, entry: FoldEntry): Promise<void> {
  await $.store.set(FOLD(entry.id), entry);
}

export async function allFolds($: EngineInterface): Promise<FoldEntry[]> {
  const keys = (await $.store.keys()).filter((k: string) => k.startsWith('origami:fold:'));
  const out: FoldEntry[] = [];
  for (const k of keys) {
    const e = (await $.store.get(k)) as FoldEntry | undefined;
    if (e) out.push(e);
  }
  return out;
}

export async function appendLog($: EngineInterface, record: Record<string, unknown>): Promise<void> {
  let prior = '';
  try { if (await $.fs.exists(LOG)) prior = String(await $.fs.read(LOG)); } catch { prior = ''; }
  const line = JSON.stringify({ ts: new Date().toISOString(), ...record });
  await $.fs.write(LOG, prior === '' ? line + '\n' : prior + line + '\n');
}
