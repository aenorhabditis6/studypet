// Thin wrapper over the Tauri APIs. Outside Tauri (a plain browser tab, used as a design
// preview) calls go to an in-memory mock instead.
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { emit as tauriEmit, listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event";

export const inTauri = "__TAURI_INTERNALS__" in window;

// `import.meta.env.DEV &&` keeps the browser mock out of production builds entirely.

export function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (import.meta.env.DEV && !inTauri) return import("../dev/mock").then((m) => m.mockInvoke<T>(cmd, args));
  return tauriInvoke<T>(cmd, args);
}

export function listen<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  if (import.meta.env.DEV && !inTauri) {
    return import("../dev/mock").then((m) => m.mockListen(event, handler as (p: unknown) => void));
  }
  return tauriListen<T>(event, (e) => handler(e.payload));
}

/** Broadcasts to every window (including this one). */
export function emit(event: string, payload?: unknown): Promise<void> {
  if (import.meta.env.DEV && !inTauri) return import("../dev/mock").then((m) => m.mockEmit(event, payload));
  return tauriEmit(event, payload);
}

/** Logs to the devtools console and to the terminal running `tauri dev`. */
export function log(...parts: unknown[]): void {
  const msg = parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ");
  console.log(msg);
  if (inTauri) void tauriInvoke("log_line", { msg }).catch(() => {});
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
