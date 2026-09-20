export type StoreIO = {
  fsRead: (path: string) => Promise<string>;
  fsWrite: (path: string, text: string) => Promise<void>;
  fsExists: (path: string) => Promise<boolean>;
  // storeGet/storeSet/storeKeys are PROJECT-SCOPED by the caller: origami.ts bakes a
  // per-project prefix into these closures (see storeIO($)), so every key seen here is
  // already this project's own and storeKeys() returns prefix-stripped keys.
  storeGet: (key: string) => Promise<unknown>;
  storeSet: (key: string, value: unknown) => Promise<void>;
  storeKeys: () => Promise<string[]>;
};

export type FoldEntry = {
  id: string; stub: string; state: 'folded' | 'pinned' | 'evicted';
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

// A fold body file is `<header>` + this delimiter + the ORIGINAL bytes. Splitting on
// the delimiter is what makes restores byte-exact and stops the header nesting on
// unpin -> refold cycles. A file written without a header has no delimiter and is
// returned whole.
export const BODY_DELIMITER = '\n<<<origami:body>>>\n';

export async function newFoldId(io: StoreIO): Promise<string> {
  const n = Number((await io.storeGet(SEQ)) ?? 0) + 1;
  await io.storeSet(SEQ, n);
  return `fold-${String(n).padStart(3, '0')}`;
}

export async function putFold(io: StoreIO, entry: FoldEntry, body: string, header?: string): Promise<void> {
  await io.fsWrite(BODY(entry.id), header === undefined ? body : header + BODY_DELIMITER + body);
  await io.storeSet(FOLD(entry.id), entry);
}

export async function getFold(
  io: StoreIO, id: string,
): Promise<{ entry: FoldEntry; body: string; header?: string } | undefined> {
  const entry = (await io.storeGet(FOLD(id))) as FoldEntry | undefined;
  if (!entry) return undefined;
  const raw = String(await io.fsRead(BODY(id)));
  const at = raw.indexOf(BODY_DELIMITER);
  if (at === -1) return { entry, body: raw };
  return { entry, body: raw.slice(at + BODY_DELIMITER.length), header: raw.slice(0, at) };
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

// Best-effort telemetry: the log is a diagnostic, never a dependency. A write that
// rejects (the engine's 4 MiB fs ceiling, an OS refusal) must not take down a hydrate
// or abort a sweep, so every failure here is swallowed. Signature stays `Promise<void>`.
export async function appendLog(io: StoreIO, record: Record<string, unknown>): Promise<void> {
  try {
    let prior = '';
    try { if (await io.fsExists(LOG)) prior = String(await io.fsRead(LOG)); } catch { prior = ''; }
    const line = JSON.stringify({ ts: new Date().toISOString(), ...record });
    await io.fsWrite(LOG, prior === '' ? line + '\n' : prior + line + '\n');
  } catch { /* telemetry must never break the caller */ }
}
