// The panel window: first-run onboarding, the "today" list, and settings.
import { errorText, inTauri, invoke, listen, log } from "../shared/bridge";
import { keys, store } from "../shared/store";
import type { PetInfo } from "../shared/types";
import { h } from "./dom";
import { renderOnboarding } from "./onboarding";
import { renderSettings } from "./settings";
import { renderToday } from "./today";

export type View = "onboarding" | "today" | "settings";

export interface Nav {
  go(view: View): void;
}

type Render = (root: HTMLElement, nav: Nav) => Promise<(() => void) | void>;
const VIEWS: Record<View, Render> = { onboarding: renderOnboarding, today: renderToday, settings: renderSettings };

const app = document.getElementById("app")!;
const tabs = h(
  "nav",
  { class: "tabs" },
  h("button", { type: "button", "data-view": "today", onclick: () => nav.go("today") }, "今天"),
  h("button", { type: "button", "data-view": "settings", onclick: () => nav.go("settings") }, "设置"),
);
document.body.append(tabs);

let current: View | null = null;
let cleanup: (() => void) | void;
let seq = 0;

async function go(view: View) {
  const n = ++seq;
  const keepScroll = view === current ? window.scrollY : 0;
  const root = h("div", { class: `view view-${view}` });
  const nextCleanup = await VIEWS[view](root, nav).catch((e) => {
    root.append(h("p", { class: "error" }, `出错了：${errorText(e)}`));
    log("panel: render failed", view, errorText(e));
  });
  if (n !== seq) {
    nextCleanup?.();
    return;
  }
  cleanup?.();
  cleanup = nextCleanup;
  current = view;
  app.replaceChildren(root);
  document.body.dataset.view = view;
  for (const b of tabs.querySelectorAll("button")) b.classList.toggle("active", b.dataset.view === view);
  window.scrollTo(0, keepScroll);
}

const nav: Nav = { go: (v) => void go(v) };

async function main() {
  if (!inTauri) document.body.classList.add("preview");
  const asked = new URLSearchParams(location.search).get("view") as View | null;
  const pet = await invoke<PetInfo | null>("get_pet");
  const onboarded = (await (await store()).get<boolean>(keys.onboarded)) ?? false;
  await go(asked ?? (pet && onboarded ? "today" : "onboarding"));

  await listen<string>("panel-navigate", (v) => {
    if (v !== "onboarding" && v !== "today" && v !== "settings") return;
    if (current === "onboarding" && v !== "onboarding") return; // finish onboarding first
    void go(v);
  });
  const rerender = (views: View[]) => () => {
    if (current && views.includes(current)) void go(current);
  };
  await listen("data-updated", rerender(["today"]));
  await listen("done-changed", rerender(["today"]));
  await listen("pet-changed", rerender(["today", "settings"]));
}

main().catch((e) => log("panel: fatal", errorText(e)));
