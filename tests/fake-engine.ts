import type { EngineInterface } from 'claude-code';

type ModelCompleteRequest = { model: string; prompt: string; maxTokens?: number };
type ModelCompleteHandler = (req: ModelCompleteRequest) => string | Promise<string>;

export function fakeEngine(): {
  $: EngineInterface;
  files: Map<string, string>;
  kv: Map<string, unknown>;
  logs: string[];
  setModelComplete: (fn: ModelCompleteHandler) => void;
} {
  const files = new Map<string, string>();
  const kv = new Map<string, unknown>();
  const logs: string[] = [];
  let modelHandler: ModelCompleteHandler = () => {
    throw new Error('no model handler set');
  };
  const $ = {
    fs: {
      read: async (path: string) => {
        if (!files.has(path)) throw new Error(`ENOENT: ${path}`); // documented: $.fs.read rejects when missing
        return files.get(path)!;
      },
      write: async (path: string, text: string) => { files.set(path, text); },
      exists: async (path: string) => files.has(path),
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
  return {
    $, files, kv, logs,
    setModelComplete: (fn: ModelCompleteHandler) => { modelHandler = fn; },
  };
}
