// Choosing a pet: the two built-in ones, or an upload in one of three forms.
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "../shared/bridge";
import { h, openLink } from "./dom";

/** How to make a pet with every expression and move (published with the downloads). */
export const MAKE_A_PET_URL = "https://github.com/aenorhabditis6/studypet-releases/blob/main/MAKE-A-PET.md";

export type UploadChoice = "cutout" | "original" | "codex";

const IMAGES = [{ name: "图片", extensions: ["png", "webp", "gif", "jpg", "jpeg"] }];

/** Asks for the file or folder and imports it. Resolves false if the user cancelled. */
export async function uploadPet(choice: UploadChoice): Promise<boolean> {
  const path = await open(
    choice === "codex"
      ? { directory: true, multiple: false, title: "选择 Codex 宠物文件夹（里面有 pet.json）" }
      : { multiple: false, title: choice === "cutout" ? "选一张图片（会自动抠图）" : "选一张图片（保持原图）", filters: IMAGES },
  );
  if (typeof path !== "string") return false;
  await invoke("import_pet", { path, mode: choice === "codex" ? null : choice });
  return true;
}

export function useBuiltIn(id: "cloudbun" | "naidan"): Promise<unknown> {
  return invoke("use_default_pet", { id });
}

function choice(icon: string, title: string, detail: string, onclick: () => unknown, extra?: HTMLElement | null) {
  return h(
    "div",
    { class: "choice" },
    h(
      "button",
      { class: "choice-main", type: "button", onclick },
      h("span", { class: "choice-icon", "aria-hidden": "true" }, icon),
      h("span", null, h("b", null, title), h("span", { class: "choice-detail" }, detail)),
    ),
    extra ?? null,
  );
}

/** The two built-in pets. */
export function builtInChoices(pick: (id: "cloudbun" | "naidan") => unknown): HTMLElement {
  return h(
    "div",
    { class: "choices two" },
    choice("🐰", "Cloudbun", "会挥手、蹦跳、转头看你", () => pick("cloudbun")),
    choice("🥚", "奶蛋", "眼睛会跟着鼠标转", () => pick("naidan")),
  );
}

/** Upload a picture (cut out / as is) or a Codex pet with every expression. */
export function uploadChoices(pick: (c: UploadChoice) => unknown): HTMLElement {
  return h(
    "div",
    { class: "choices" },
    choice("✂️", "上传图片 · 自动抠图（推荐）", "去掉背景，找到眼睛让它跟着鼠标转", () => pick("cutout")),
    choice("🖼️", "上传图片 · 原图", "保持图片原样，只做整体的动作", () => pick("original")),
    choice(
      "🎞️",
      "上传表情图 · Codex 宠物",
      "一整套表情和动作的精灵图（pet.json 所在的文件夹）",
      () => pick("codex"),
      h("button", { class: "btn link small how", type: "button", onclick: () => openLink(MAKE_A_PET_URL) }, "怎么做？"),
    ),
  );
}
