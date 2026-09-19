import type { EngineInterface } from 'claude-code';

export function fakeEngine(): { $: EngineInterface; files: Map<string, string>; kv: Map<string, unknown> } {
  const files = new Map<string, string>();
  const kv = new Map<string, unknown>();
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
  } as unknown as EngineInterface;
  return { $, files, kv };
}
