// Non-secret app state, shared by both windows through the store plugin
// (`<app data>/studypet.json`). Secrets (feed URLs) never go here — see sources.rs.
import { load, type Store } from "@tauri-apps/plugin-store";
import { inTauri } from "./bridge";
import { DEFAULT_SETTINGS, type Item, type Settings, type Source } from "./types";

export interface KV {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

let kv: Promise<KV> | null = null;

export function store(): Promise<KV> {
  kv ??=
    import.meta.env.DEV && !inTauri
      ? import("../dev/mock").then((m) => m.previewKV())
      : load("studypet.json", { autoSave: 100 }).then(wrap);
  return kv;
}

function wrap(s: Store): KV {
  return { get: (k) => s.get(k), set: (k, v) => s.set(k, v) };
}

export const keys = {
  sources: "sources",
  items: "items",
  done: "done",
  lastSync: "lastSync",
  petPos: "petPos",
  settings: "settings",
  onboarded: "onboarded",
  notices: "notices",
  edCourses: "edCourses",
  /** Where the pet sits: its body centre in physical screen px, and whether it's tucked at an edge. */
  petAt: "petAt",
  session: "session",
} as const;

/** Item id → when it was marked done. */
export type DoneMap = Record<string, number>;

export async function getSources(): Promise<Source[]> {
  return (await (await store()).get<Source[]>(keys.sources)) ?? [];
}

export async function getItems(): Promise<Item[]> {
  return (await (await store()).get<Item[]>(keys.items)) ?? [];
}

export async function getDone(): Promise<DoneMap> {
  return (await (await store()).get<DoneMap>(keys.done)) ?? {};
}

export async function getSettings(): Promise<Settings> {
  return { ...DEFAULT_SETTINGS, ...((await (await store()).get<Partial<Settings>>(keys.settings)) ?? {}) };
}
