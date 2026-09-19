export type StoreIO = {
  fsRead: (path: string) => Promise<string>;
  fsWrite: (path: string, text: string) => Promise<void>;
  fsExists: (path: string) => Promise<boolean>;
  storeGet: (key: string) => Promise<unknown>;
  storeSet: (key: string, value: unknown) => Promise<void>;
  storeKeys: () => Promise<string[]>;
};

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

export async function newFoldId(io: StoreIO): Promise<string> {
  const n = Number((await io.storeGet(SEQ)) ?? 0) + 1;
  await io.storeSet(SEQ, n);
  return `fold-${String(n).padStart(3, '0')}`;
}

export async function putFold(io: StoreIO, entry: FoldEntry, body: string): Promise<void> {
  await io.fsWrite(BODY(entry.id), body);
  await io.storeSet(FOLD(entry.id), entry);
}

export async function getFold(io: StoreIO, id: string): Promise<{ entry: FoldEntry; body: string } | undefined> {
  const entry = (await io.storeGet(FOLD(id))) as FoldEntry | undefined;
  if (!entry) return undefined;
  const body = String(await io.fsRead(BODY(id)));
  return { entry, body };
}

export async function setFold(io: StoreIO, entry: FoldEntry): Promise<void> {
  await io.storeSet(FOLD(entry.id), entry);
}

export async function allFolds(io: StoreIO): Promise<FoldEntry[]> {
  const keys = (await io.storeKeys()).filter((k: string) => k.startsWith('origami:fold:'));
  const out: FoldEntry[] = [];
  for (const k of keys) {
    const e = (await io.storeGet(k)) as FoldEntry | undefined;
    if (e) out.push(e);
  }
  return out;
}

export async function appendLog(io: StoreIO, record: Record<string, unknown>): Promise<void> {
  let prior = '';
  try { if (await io.fsExists(LOG)) prior = String(await io.fsRead(LOG)); } catch { prior = ''; }
  const line = JSON.stringify({ ts: new Date().toISOString(), ...record });
  await io.fsWrite(LOG, prior === '' ? line + '\n' : prior + line + '\n');
}
