// First run: 1) the user brings their own pet, 2) connects Canvas, 3) meets the pet.
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { emit, errorText, inTauri, invoke } from "../shared/bridge";
import { getSources, keys, store } from "../shared/store";
import { addSource } from "../shared/sync";
import type { CodexPetRef, PetInfo, Source, SourceKind } from "../shared/types";
import type { PetView } from "../pet/sprite";
import { button, h, petPreview } from "./dom";
import { builtInChoices, uploadChoices, uploadPet, useBuiltIn } from "./pet-picker";
import type { Nav } from "./main";

const STEPS = ["选宠物", "连 Canvas", "完成"];

export async function renderOnboarding(root: HTMLElement, nav: Nav): Promise<() => void> {
  let step = 1;
  let choosing = false;
  let preview: PetView | null = null;
  let dropZone: HTMLElement | null = null;
  let importFrom: (path: string, origin?: string) => Promise<void> = async () => {};
  const box = h("div", { class: "onboarding" });
  root.append(box);

  async function show(n: number) {
    step = n;
    preview?.destroy();
    preview = null;
    dropZone = null;
    const content = n === 1 ? await stepPet() : n === 2 ? await stepCalendars() : await stepDone();
    box.replaceChildren(stepper(n), content);
  }

  function stepper(n: number) {
    return h(
      "ol",
      { class: "stepper" },
      STEPS.map((label, i) => h("li", { class: i + 1 === n ? "on" : i + 1 < n ? "past" : "" }, h("span", null, i + 1), label)),
    );
  }

  // --- Step 1: the pet -------------------------------------------------------

  async function stepPet(): Promise<HTMLElement> {
    const pet = await invoke<PetInfo | null>("get_pet");
    const codexPets = await invoke<CodexPetRef[]>("list_codex_pets");
    const error = h("p", { class: "error", role: "alert" });

    importFrom = async (path: string, origin?: string) => {
      error.textContent = "";
      try {
        await invoke<PetInfo>("import_pet", { path, origin });
        choosing = false;
        await show(1);
      } catch (e) {
        error.textContent = errorText(e);
      }
    };
    const done = async (task: () => Promise<unknown>) => {
      error.textContent = "";
      try {
        if ((await task()) === false) return; // cancelled the file dialog
        choosing = false;
        await show(1);
      } catch (e) {
        error.textContent = errorText(e);
      }
    };

    const intro = [
      h("h1", null, "先选一只陪你的宠物"),
      h("p", { class: "lead" }, "它会住在你的桌面角落，帮你盯着上课和 due，累了也可以找它。"),
    ];

    if (pet && !choosing) {
      try {
        preview = await petPreview(pet, 120);
      } catch (e) {
        error.textContent = `这只宠物的图片读不出来（${errorText(e)}），换一只吧`;
      }
    }
    if (pet && !choosing && preview) {
      void preview.play("waving", 2);
      return h(
        "section",
        null,
        ...intro,
        h(
          "div",
          { class: "pet-card" },
          h("div", { class: "pet-stage" }, preview.el),
          h("div", { class: "pet-name" }, pet.name),
          h("div", { class: "pet-kind" }, describePet(pet)),
          preview.features.length ? h("div", { class: "pet-kind" }, preview.features.join(" · ")) : null,
          h("button", { class: "btn link", type: "button", onclick: () => ((choosing = true), void show(1)) }, "换一只"),
        ),
        h("div", { class: "actions" }, button("下一步", () => show(2), "btn primary")),
      );
    }

    dropZone = h(
      "div",
      { class: "drop compact" },
      h("span", null, "🐾 也可以直接把图片或 Codex 宠物文件夹拖到这里"),
    );
    return h(
      "section",
      null,
      ...intro,
      h("h3", null, "用内置的"),
      builtInChoices((id) => done(() => useBuiltIn(id))),
      h("h3", null, "或者上传你自己的"),
      uploadChoices((c) => done(() => uploadPet(c))),
      dropZone,
      error,
      codexPets.length
        ? h(
            "div",
            { class: "found" },
            h("h3", null, "在你的 Codex 里找到了"),
            codexPets.map((p) =>
              h("div", { class: "found-pet" }, h("span", null, p.name), button("用它", () => importFrom(p.path, "codex"), "btn small")),
            ),
          )
        : null,
      pet ? h("div", { class: "actions" }, button("取消", () => ((choosing = false), void show(1)), "btn")) : null,
    );
  }

  // --- Step 2: calendars -----------------------------------------------------

  async function stepCalendars(): Promise<HTMLElement> {
    const list = h("ul", { class: "source-list" });
    const renderList = async () => {
      const sources = await getSources();
      list.replaceChildren(...sources.map(sourceLine));
      next.textContent = sources.length ? "下一步" : "先跳过";
    };
    const next = button("下一步", () => show(3), "btn primary");

    const canvasForm = linkForm("canvas", "https://学校.instructure.com/feeds/calendars/user_….ics", renderList);
    const otherForm = linkForm("calendar", "Google / Outlook / 课表的 .ics 链接", renderList);

    const section = h(
      "section",
      null,
      h("h1", null, "连接 Canvas"),
      h("p", { class: "lead" }, "用 Canvas 自带的「日历订阅链接」，不需要密码，也不需要 token。"),
      h(
        "ol",
        { class: "guide" },
        h("li", null, "在浏览器里打开 Canvas，点左边的 ", h("b", null, "Calendar / 日历")),
        h("li", null, "在日历页右侧栏底部，点 ", h("b", null, "Calendar Feed / 日历订阅")),
        h("li", null, "复制弹出来的链接，粘贴到下面"),
      ),
      canvasForm,
      h(
        "details",
        { class: "more" },
        h("summary", null, "还想加上课表或 Google 日历？"),
        h(
          "p",
          { class: "hint" },
          "Google 日历：设置 → 选中你的日历 → 「iCal 格式的私密地址」。学校课表如果能导出 .ics，也可以贴在这里。",
        ),
        otherForm,
      ),
      list,
      h("p", { class: "privacy" }, "🔒 链接只存在这台电脑的系统钥匙串里，作业和日程也只保存在本机。"),
      h("div", { class: "actions" }, button("上一步", () => show(1)), next),
    );
    await renderList();
    return section;
  }

  // --- Step 3: done ----------------------------------------------------------

  async function stepDone(): Promise<HTMLElement> {
    const pet = await invoke<PetInfo | null>("get_pet");
    if (pet) {
      preview = await petPreview(pet, 110).catch(() => null);
      void preview?.play("jumping", 3);
    }
    const tip = (what: string, how: string) => h("li", null, h("b", null, what), how);
    return h(
      "section",
      null,
      h("h1", null, "准备好啦！"),
      preview ? h("div", { class: "pet-stage center" }, preview.el) : null,
      h(
        "ul",
        { class: "tips" },
        tip("单击它", "看看下一个 due"),
        tip("双击它", "打开这个面板"),
        tip("拖动它", "换个地方待着"),
        tip("右键它", "同步、设置、先藏起来"),
        tip("菜单栏小图标", "宠物藏起来了也能找回来"),
      ),
      h(
        "p",
        { class: "hint" },
        "作业会在截止前 3 天、1 天、3 小时各提醒一次；上课前 15 分钟会叫你出发。",
      ),
      h("div", { class: "actions" }, button("上一步", () => show(2)), button("开始吧", finish, "btn primary")),
    );
  }

  async function finish() {
    await (await store()).set(keys.onboarded, true);
    await invoke("set_pet_visible", { visible: true });
    await emit("onboarded");
    if (inTauri) await invoke("hide_panel");
    nav.go("today");
  }

  // Drag & drop onto the window (step 1 only).
  let unlisten: (() => void) | null = null;
  if (inTauri) {
    unlisten = await getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (step !== 1 || !dropZone) return;
      if (payload.type === "enter" || payload.type === "over") dropZone.classList.add("hover");
      else if (payload.type === "leave") dropZone.classList.remove("hover");
      else if (payload.type === "drop") {
        dropZone.classList.remove("hover");
        if (payload.paths[0]) void importFrom(payload.paths[0]);
      }
    });
  }

  await show(1);
  return () => {
    preview?.destroy();
    unlisten?.();
  };
}

export function describePet(pet: PetInfo): string {
  const from = pet.origin === "default" ? "默认宠物" : pet.origin === "codex" ? "来自 Codex" : "你上传的";
  const what = pet.kind === "codex-atlas" ? "Codex 精灵图，会用它自己的动作" : "单张图片：自动去掉背景，我来帮它动起来";
  return `${from} · ${what}`;
}

export function sourceLine(s: Source): HTMLElement {
  const detail = s.lastError
    ? h("span", { class: "bad" }, `同步失败：${s.lastError}`)
    : h("span", null, s.counts ? `${s.counts.deadlines} 个作业 · ${s.counts.events} 个日程` : "");
  return h(
    "li",
    null,
    h("span", { class: "tag" }, s.kind === "canvas" ? "Canvas" : "日历"),
    h("span", { class: "name" }, s.name),
    detail,
  );
}

/** URL field + "test & save" button for one kind of calendar. */
export function linkForm(kind: SourceKind, placeholder: string, onAdded: () => unknown): HTMLElement {
  const input = h("input", { type: "url", placeholder, spellcheck: false, autocomplete: "off" });
  const status = h("p", { class: "status", role: "status" });
  const save = h("button", { class: "btn primary", type: "button" }, "测试并保存");
  const submit = async () => {
    const url = input.value.trim();
    if (!url) {
      status.className = "status bad";
      status.textContent = "先把链接粘贴进来～";
      return;
    }
    save.disabled = true;
    status.className = "status";
    status.textContent = "正在读取日历…";
    try {
      const { counts } = await addSource(kind, url);
      status.className = "status good";
      status.textContent = `✓ 连上了！找到 ${counts.deadlines} 个作业、${counts.events} 个日程`;
      input.value = "";
      await onAdded();
    } catch (e) {
      status.className = "status bad";
      status.textContent = errorText(e);
    } finally {
      save.disabled = false;
    }
  };
  save.addEventListener("click", () => void submit());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void submit();
  });
  return h("div", { class: "link-form" }, h("div", { class: "row" }, input, save), status);
}
