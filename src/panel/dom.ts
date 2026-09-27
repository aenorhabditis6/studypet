import { openUrl } from "@tauri-apps/plugin-opener";
import { ask } from "@tauri-apps/plugin-dialog";
import { inTauri, invoke } from "../shared/bridge";
import type { PetInfo } from "../shared/types";
import { createPetView, type PetView } from "../pet/sprite";

type Child = Node | string | number | null | undefined | false;

/** Tiny element builder. Strings become text nodes, so untrusted text (feed titles) is safe. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Record<string, unknown> | null,
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = String(v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v as EventListener);
    else if (k in node && typeof v !== "string") (node as unknown as Record<string, unknown>)[k] = v;
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c !== null && c !== undefined && c !== false) node.append(typeof c === "number" ? String(c) : c);
  }
  return node;
}

export function button(label: string, onclick: () => unknown, cls = "btn"): HTMLButtonElement {
  return h("button", { class: cls, type: "button", onclick }, label);
}

/** Loads the current pet into a small animated preview. */
export async function petPreview(info: PetInfo, height: number): Promise<PetView> {
  const bytes = await invoke<ArrayBuffer>("get_pet_image");
  const url = URL.createObjectURL(new Blob([bytes], { type: info.mime }));
  return createPetView(info.kind, url, height, info.mode);
}

export function openLink(url: string) {
  if (inTauri) void openUrl(url);
  else window.open(url, "_blank", "noopener");
}

export async function confirmAction(message: string): Promise<boolean> {
  if (inTauri) return ask(message, { title: "StudyPet", kind: "warning" });
  return window.confirm(message);
}
