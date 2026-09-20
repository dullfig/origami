import type { EngineInterface } from 'claude-code';
import type { StoreIO } from '../hooks/store';

type ModelCompleteRequest = { model: string; prompt: string; maxTokens?: number };
type ModelCompleteHandler = (req: ModelCompleteRequest) => string | Promise<string>;

export function fakeEngine(root = '/proj/alpha'): {
  $: EngineInterface;
  io: StoreIO;
  files: Map<string, string>;
  kv: Map<string, unknown>;
  logs: string[];
  setModelComplete: (fn: ModelCompleteHandler) => void;
  failWritesWhen: (pred: (path: string) => boolean) => void;
} {
  const files = new Map<string, string>();
  const kv = new Map<string, unknown>();
  const logs: string[] = [];
  let writeFails: (path: string) => boolean = () => false;
  let modelHandler: ModelCompleteHandler = () => {
    throw new Error('no model handler set');
  };
  const write = async (path: string, text: string) => {
    if (writeFails(path)) throw new Error(`EFBIG: ${path} exceeds the 4 MiB limit`);
    files.set(path, text);
  };
  const $ = {
    fs: {
      read: async (path: string) => {
        if (!files.has(path)) throw new Error(`ENOENT: ${path}`); // documented: $.fs.read rejects when missing
        return files.get(path)!;
      },
      write,
      exists: async (path: string) => files.has(path),
    },
    session: {
      // the real engine's per-project discriminator (types/claude-code.d.ts ~:2369)
      root: async () => root,
      cwd: async () => root,
    },
    store: {
      get: async (key: string) => kv.get(key),
      set: async (key: string, value: unknown) => { kv.set(key, value); },
      keys: async () => [...kv.keys()],
    },
    model: {
      complete: async (req: ModelCompleteRequest) => modelHandler(req),
    },
    ui: {
      log: (text: string) => { logs.push(text); },
    },
  } as unknown as EngineInterface;
  const io: StoreIO = {
    fsRead: async (path: string) => {
      if (!files.has(path)) throw new Error(`ENOENT: ${path}`);
      return files.get(path)!;
    },
    fsWrite: write,
    fsExists: async (path: string) => files.has(path),
    storeGet: async (key: string) => kv.get(key),
    storeSet: async (key: string, value: unknown) => { kv.set(key, value); },
    storeKeys: async () => [...kv.keys()],
  };
  return {
    $, io, files, kv, logs,
    setModelComplete: (fn: ModelCompleteHandler) => { modelHandler = fn; },
    failWritesWhen: (pred: (path: string) => boolean) => { writeFails = pred; },
  };
}
