export type StoreIO = {
  fsRead: (path: string) => Promise<string>;
  fsWrite: (path: string, text: string) => Promise<void>;
  fsExists: (path: string) => Promise<boolean>;
  // storeGet/storeSet/storeKeys are PROJECT-SCOPED by the caller: origami.ts bakes a
  // per-project prefix into these closures (see storeIO($)), so every key seen here is
  // already this project's own and storeKeys() returns prefix-stripped keys.
  storeGet: (key: string) => Promise<unknown>;
  storeSet: (key: string, value: unknown) => Promise<void>;
  storeDelete: (key: string) => Promise<void>;
  storeKeys: () => Promise<string[]>;
};

export type FoldEntry = {
  id: string; stub: string; state: 'folded' | 'pinned' | 'evicted';
  tool: string; toolUseId: string; inputKey: string;
  originAge: number; sizeTokens: number; hydrations: number;
  // Staleness (v1.1). originHash: FNV of the RAW file bytes at fold time, set only for
  // file-backed folds (input had a string file_path) that were readable then; absent ⇒
  // the fold is not staleness-tracked. stale: an append-only signal flipped by the
  // writer-hook when an Edit/Write hits this fold's path, cleared once a sweep marker
  // has reported it. Neither is load-bearing for correctness — hydrate re-hashes the
  // live file against originHash authoritatively — they only drive the proactive signal.
  originHash?: string; stale?: boolean;
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

// --- Keep-memory (delta sweeps) ---
// A candidate the librarian EXPLICITLY ruled `keep` stays inline, aged and bulky, and
// would otherwise be re-offered wholesale on EVERY later sweep — the observed
// ~100k-token, ~30s prefill that reads the same content twice running. Remembering the
// verdict, keyed by the tool_use_id and fingerprinted by the content hash, makes
// steady-state sweeps read only NEW mass. The hash is what makes the memory safe: if
// the same id ever carries different text, the verdict no longer applies and the
// candidate is offered again. A DEFAULTED keep (the librarian never actually judged
// it — an omission, or a whole batch whose call failed) is never written here: it must
// stay retryable, not become a permanent suppression (see origami.ts's recording loop).
export type KeepEntry = { hash: string; ts: string };

const KEEP_PREFIX = 'origami:keep:';
const KEEP = (toolUseId: string) => `${KEEP_PREFIX}${toolUseId}`;

// Mirrors allFolds: enumerate the project-scoped keys, read each entry back. Returns
// a map tool_use_id -> entry so callers can probe by id without another round trip.
export async function getKeeps(io: StoreIO): Promise<Map<string, KeepEntry>> {
  const keys = (await io.storeKeys()).filter((k: string) => k.startsWith(KEEP_PREFIX));
  const out = new Map<string, KeepEntry>();
  for (const k of keys) {
    const e = (await io.storeGet(k)) as KeepEntry | undefined;
    if (e && typeof e.hash === 'string') out.set(k.slice(KEEP_PREFIX.length), e);
  }
  return out;
}

export async function putKeep(io: StoreIO, toolUseId: string, hash: string): Promise<void> {
  const entry: KeepEntry = { hash, ts: new Date().toISOString() };
  await io.storeSet(KEEP(toolUseId), entry);
}

export async function dropKeep(io: StoreIO, toolUseId: string): Promise<void> {
  await io.storeDelete(KEEP(toolUseId));
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
