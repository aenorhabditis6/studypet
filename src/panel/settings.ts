import { open } from "@tauri-apps/plugin-dialog";
import { emit, errorText, invoke } from "../shared/bridge";
import { ago } from "../shared/format";
import { getSettings, getSources, keys, store } from "../shared/store";
import { ED_TOKEN_PAGE } from "../shared/ed";
import * as lines from "../shared/lines";
import { connectEd, connectGradescope, removeSource } from "../shared/sync";
import { WECHAT, type PetInfo, type Settings, type Source } from "../shared/types";
import type { PetView } from "../pet/sprite";
import { button, confirmAction, h, petPreview } from "./dom";
import type { Nav } from "./main";
import { describePet, linkForm } from "./onboarding";

export async function renderSettings(root: HTMLElement, nav: Nav): Promise<() => void> {
  const [pet, settings] = await Promise.all([invoke<PetInfo | null>("get_pet"), getSettings()]);
  const save = async (patch: Partial<Settings>) => {
    await (await store()).set(keys.settings, { ...(await getSettings()), ...patch });
    await emit("settings-changed");
  };

  // Pet
  let preview: PetView | null = null;
  const petError = h("p", { class: "error", role: "alert" });
  const replace = async (directory: boolean) => {
    const path = await open(
      directory
        ? { directory: true, multiple: false, title: "选择 Codex 宠物文件夹" }
        : { multiple: false, title: "选择宠物图片或 pet.json", filters: [{ name: "宠物", extensions: ["png", "webp", "gif", "jpg", "jpeg", "json"] }] },
    );
    if (typeof path !== "string") return;
    try {
      await invoke("import_pet", { path }); // emits pet-changed → this view re-renders
    } catch (e) {
      petError.textContent = errorText(e);
    }
  };
  if (pet) {
    preview = await petPreview(pet, 84).catch((e) => {
      petError.textContent = `宠物图片读不出来（${errorText(e)}），换一只吧`;
      return null;
    });
  }
  const size = h("input", { type: "range", min: 80, max: 150, step: 10, value: String(settings.petSize), "aria-label": "宠物大小" });
  const sizeLabel = h("span", { class: "value" }, `${settings.petSize}px`);
  size.addEventListener("input", () => (sizeLabel.textContent = `${size.value}px`));
  size.addEventListener("change", () => void save({ petSize: Number(size.value) }));

  root.append(
    h(
      "section",
      { class: "block" },
      h("h2", null, "宠物"),
      h(
        "div",
        { class: "pet-row" },
        h("div", { class: "pet-stage small" }, preview?.el),
        h("div", null, h("div", { class: "pet-name" }, pet?.name ?? "还没有宠物"), pet ? h("div", { class: "pet-kind" }, describePet(pet)) : null),
      ),
      h(
        "div",
        { class: "row wrap" },
        button("换一只（图片 / pet.json）…", () => replace(false), "btn small"),
        button("选宠物文件夹…", () => replace(true), "btn small"),
        pet?.origin !== "default" ? button("换回 Cloudbun", () => invoke("use_default_pet"), "btn small") : null,
      ),
      petError,
      pet ? nameField(pet.name, petError) : null,
      h("label", { class: "field" }, h("span", null, "大小"), size, sizeLabel),
    ),
  );

  // Calendars — the list refreshes in place so a form's "connected!" message stays visible.
  const list = h("div");
  const renderSources = async () => {
    const current = (await getSources()).filter((s) => s.kind === "canvas" || s.kind === "calendar");
    list.replaceChildren(
      current.length
        ? h("ul", { class: "source-list editable" }, current.map((s) => sourceRow(s, renderSources)))
        : h("p", { class: "quiet" }, "还没有连接任何日历。"),
    );
  };
  await renderSources();
  root.append(
    h(
      "section",
      { class: "block" },
      h("h2", null, "日历"),
      list,
      h("h3", null, "添加 Canvas 日历订阅"),
      h("p", { class: "hint" }, "Canvas → Calendar → 右侧栏底部的 Calendar Feed → 复制链接"),
      linkForm("canvas", "https://学校.instructure.com/feeds/calendars/user_….ics", renderSources),
      h("h3", null, "添加其他日历（.ics）"),
      h("p", { class: "hint" }, "Google 日历的「iCal 格式的私密地址」、Outlook 发布的日历、学校课表导出的链接"),
      linkForm("calendar", "https://….ics", renderSources),
    ),
  );

  root.append(await gradescopeSection(), await edSection());

  // Random lines for clicks #3 and beyond, one per line.
  const quips = h("textarea", { rows: 8, spellcheck: false, "aria-label": "随机台词" });
  quips.value = (settings.quips?.length ? settings.quips : lines.DEFAULT_QUIPS).join("\n");
  const saveQuips = () => {
    const list = quips.value.split("\n").map((q) => q.trim()).filter(Boolean);
    return save({ quips: list.length ? list : undefined });
  };
  quips.addEventListener("change", () => void saveQuips());
  root.append(
    h(
      "section",
      { class: "block" },
      h("h2", null, "宠物台词"),
      h("p", { class: "hint" }, "单击宠物：第 1 次说下一个作业，第 2 次说再下一个，之后从下面随机挑一句（一行一句）。"),
      quips,
      h(
        "div",
        { class: "row" },
        button("恢复默认", async () => {
          quips.value = lines.DEFAULT_QUIPS.join("\n");
          await save({ quips: undefined });
        }, "btn small"),
      ),
    ),
  );

  // Reminders
  const lead = h(
    "select",
    { "aria-label": "上课前多久提醒" },
    [10, 15, 30, 45, 60, 90].map((m) => h("option", { value: String(m), selected: m === settings.classLeadMin }, m >= 60 ? `${m / 60} 小时` : `${m} 分钟`)),
  );
  lead.addEventListener("change", () => void save({ classLeadMin: Number(lead.value) }));
  root.append(
    h(
      "section",
      { class: "block" },
      h("h2", null, "提醒"),
      h("label", { class: "field" }, h("span", null, "上课前"), lead, h("span", { class: "value" }, "叫你出发")),
      h("p", { class: "hint" }, "作业在截止前 3 天、1 天、3 小时各提醒一次。电脑合盖睡着时错过的提醒，醒来后会补一次。Office hours 只列在日程里，不会叫你。"),
    ),
  );

  root.append(healthSection(settings, save), await focusSection(settings, save));

  // Privacy & misc
  root.append(
    h(
      "section",
      { class: "block" },
      h("h2", null, "隐私"),
      h(
        "ul",
        { class: "plain" },
        h("li", null, "日历链接和 Ed token 存在系统钥匙串里，App 界面拿不到明文。"),
        h("li", null, "Gradescope 的登录只留在内置窗口里；我只读你自己的课程页（作业名、截止时间、交没交）。"),
        h("li", null, "作业、日程和公告只保存在这台电脑上，不会上传。"),
        h("li", null, "现在还没有接入任何 AI 服务；以后加聊天功能时会先问你。"),
      ),
    ),
    h(
      "section",
      { class: "block" },
      h(
        "div",
        { class: "row wrap" },
        button("显示宠物", () => invoke("set_pet_visible", { visible: true }), "btn small"),
        button("重新走一遍新手引导", async () => {
          await (await store()).set(keys.onboarded, false);
          nav.go("onboarding");
        }, "btn small"),
        button("退出 StudyPet", () => invoke("quit_app"), "btn small danger"),
      ),
    ),
  );

  return () => preview?.destroy();
}

function sourceRow(s: Source, onRemoved: () => unknown): HTMLElement {
  const status = s.lastError
    ? h("span", { class: "bad" }, `同步失败：${s.lastError}`)
    : h(
        "span",
        null,
        [s.counts ? `${s.counts.deadlines} 个作业 · ${s.counts.events} 个日程` : "", s.lastSync ? `${ago(s.lastSync)}同步` : ""]
          .filter(Boolean)
          .join(" · "),
      );
  return h(
    "li",
    null,
    h("span", { class: "tag" }, s.kind === "canvas" ? "Canvas" : "日历"),
    h("div", { class: "grow" }, h("div", { class: "name" }, s.name), status),
    button("删除", async () => {
      if (!(await confirmAction(`删除「${s.name}」？它的作业和日程也会从这里移除。`))) return;
      await removeSource(s.id);
      await onRemoved();
    }, "btn small"),
  );
}

function statusLine(s: Source | undefined, detail: string): HTMLElement {
  if (!s) return h("p", { class: "quiet" }, "还没连接");
  if (s.lastError) return h("p", { class: "bad" }, s.lastError);
  return h("p", { class: "good" }, `✓ 已连接 · ${detail}${s.lastSync ? ` · ${ago(s.lastSync)}同步` : ""}`);
}

/** Gradescope: log in once in the built-in window; the pet notices and connects. */
async function gradescopeSection(): Promise<HTMLElement> {
  const source = (await getSources()).find((s) => s.kind === "gradescope");
  const status = h("p", { class: "status", role: "status" });
  const check = async () => {
    status.className = "status";
    status.textContent = "正在读取 Gradescope…";
    try {
      const count = await connectGradescope();
      status.className = count === null ? "status bad" : "status good";
      status.textContent = count === null ? "还没登录成功。在 Gradescope 窗口里登录完再点一次～" : lines.gradescopeConnected(count);
    } catch (e) {
      status.className = "status bad";
      status.textContent = errorText(e);
    }
  };
  return h(
    "section",
    { class: "block" },
    h("h2", null, "Gradescope"),
    source
      ? statusLine(source, `${source.counts?.deadlines ?? 0} 个作业`)
      : h("p", { class: "hint" }, "在内置窗口里用学校账号登录一次（Stanford 选 School Credentials），我就能看到作业和交没交，还能一键去交。登录好后我会自动连上。"),
    h(
      "div",
      { class: "row wrap" },
      button(source ? "打开 Gradescope" : "打开 Gradescope 登录", () => invoke("open_service", { name: "gradescope" }), "btn small primary"),
      button(source ? "现在同步" : "我登录好了", check, "btn small"),
      source
        ? button("断开", async () => {
            if (await confirmAction("断开 Gradescope？作业会从这里移除（想彻底退出账号，在 Gradescope 窗口里点 Log Out）。")) {
              await removeSource(source.id);
            }
          }, "btn small")
        : null,
    ),
    status,
  );
}

/** Ed: a personal API token from edstem.org/us/settings/api-tokens. */
async function edSection(): Promise<HTMLElement> {
  const source = (await getSources()).find((s) => s.kind === "ed");
  const status = h("p", { class: "status", role: "status" });
  if (source) {
    return h(
      "section",
      { class: "block" },
      h("h2", null, "Ed"),
      statusLine(source, `${source.name.replace(/^Ed · /, "")} · ${source.counts?.notices ?? 0} 条近期公告`),
      h(
        "div",
        { class: "row wrap" },
        button("打开 Ed", () => invoke("open_service", { name: "ed" }), "btn small primary"),
        button("断开", async () => {
          if (await confirmAction("断开 Ed？token 会从钥匙串删除。")) await removeSource(source.id);
        }, "btn small"),
      ),
    );
  }
  const input = h("input", { type: "password", placeholder: "粘贴 Ed API token", spellcheck: false, autocomplete: "off" });
  const connect = h("button", { class: "btn primary", type: "button" }, "连接");
  const submit = async () => {
    if (!input.value.trim()) return;
    connect.disabled = true;
    status.className = "status";
    status.textContent = "正在连接 Ed…";
    try {
      const r = await connectEd(input.value);
      input.value = "";
      status.className = "status good";
      status.textContent = `✓ 连上了！${r.name}，${r.courses} 门课，${r.notices} 条近期公告`;
    } catch (e) {
      status.className = "status bad";
      status.textContent = errorText(e);
    } finally {
      connect.disabled = false;
    }
  };
  connect.addEventListener("click", () => void submit());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void submit();
  });
  return h(
    "section",
    { class: "block" },
    h("h2", null, "Ed"),
    h("p", { class: "hint" }, "连上以后，课程有新公告我会告诉你，还能看到各门课的未读数。"),
    h(
      "ol",
      { class: "guide" },
      h("li", null, "打开 Ed 的 API Tokens 页面（先用 Stanford 账号登录）：", button("打开", () => invoke("open_service", { name: "ed", url: ED_TOKEN_PAGE }), "btn small link")),
      h("li", null, "点 ", h("b", null, "Create Token"), "，复制生成的 token"),
      h("li", null, "粘贴到下面"),
    ),
    h("div", { class: "row" }, input, connect),
    status,
    h("p", { class: "privacy" }, "🔒 token 只存在这台电脑的钥匙串里，只用来读公告和未读数。"),
  );
}

function select(label: string, values: number[], current: number, text: (v: number) => string, onChange: (v: number) => void) {
  const el = h("select", { "aria-label": label }, values.map((v) => h("option", { value: String(v), selected: v === current }, text(v))));
  el.addEventListener("change", () => onChange(Number(el.value)));
  return el;
}

function checkbox(label: string, checked: boolean, onChange: (on: boolean) => void) {
  const box = h("input", { type: "checkbox", checked });
  box.addEventListener("change", () => onChange(box.checked));
  return h("label", { class: "check-row" }, box, h("span", null, label));
}

type Save = (patch: Partial<Settings>) => Promise<void>;

function healthSection(settings: Settings, save: Save): HTMLElement {
  const health = settings.health;
  return h(
    "section",
    { class: "block" },
    h("h2", null, "健康提醒"),
    checkbox("提醒我喝水、起来走走、让眼睛休息", health.enabled, (enabled) => void save({ health: { ...health, enabled } })),
    h(
      "label",
      { class: "field" },
      h("span", null, "每隔"),
      select("间隔", [30, 45, 60, 90], health.everyMin, (m) => `${m} 分钟`, (everyMin) => void save({ health: { ...health, everyMin } })),
    ),
    h("p", { class: "hint" }, "只算你在电脑前的时间：离开 5 分钟以上就重新计时。番茄钟、专注模式、组会模式和深夜都不提醒。"),
  );
}

async function focusSection(settings: Settings, save: Save): Promise<HTMLElement> {
  const pomo = settings.pomodoro;
  const running = (await invoke<{ bundleId: string; name: string }[] | null>("running_apps").catch(() => null)) ?? [];
  // WeChat is always offered, running or not; plus anything already chosen.
  const known = new Map<string, string>([[WECHAT, "微信 WeChat"]]);
  for (const id of settings.focusApps) if (!known.has(id)) known.set(id, id);
  for (const a of running) if (!known.has(a.bundleId)) known.set(a.bundleId, a.name);
  const chosen = new Set(settings.focusApps);
  const apps = h(
    "div",
    { class: "app-list" },
    [...known].map(([id, name]) =>
      checkbox(name, chosen.has(id), (on) => {
        if (on) chosen.add(id);
        else chosen.delete(id);
        void save({ focusApps: [...chosen] });
      }),
    ),
  );

  const shortcut = (label: string, value: string | undefined, key: "dndOn" | "dndOff", fallback: string) => {
    const input = h("input", { type: "text", value: value ?? "", placeholder: fallback, spellcheck: false });
    input.addEventListener("change", () => void save({ [key]: input.value.trim() || undefined }));
    const status = h("span", { class: "hint" });
    const test = button("试一下", async () => {
      status.textContent = "…";
      try {
        await invoke("run_shortcut", { name: input.value.trim() });
        status.textContent = "✓ 成功";
      } catch (e) {
        status.textContent = errorText(e);
      }
    }, "btn small");
    return h("div", { class: "field" }, h("span", null, label), input, test, status);
  };

  return h(
    "section",
    { class: "block" },
    h("h2", null, "番茄钟和专注"),
    h("p", { class: "hint" }, "右键宠物就能开始番茄钟或专注模式。专注时宠物只在作业快截止、快上课时说话。"),
    h(
      "div",
      { class: "field" },
      h("span", null, "番茄钟"),
      select("专注时长", [15, 25, 30, 45, 50], pomo.focusMin, (m) => `${m} 分钟`, (focusMin) => void save({ pomodoro: { ...pomo, focusMin } })),
      h("span", null, "休息"),
      select("休息时长", [5, 10, 15], pomo.breakMin, (m) => `${m} 分钟`, (breakMin) => void save({ pomodoro: { ...pomo, breakMin } })),
    ),
    checkbox("番茄钟期间也锁住下面这些 App", pomo.lockApps, (lockApps) => void save({ pomodoro: { ...pomo, lockApps } })),
    h("h3", null, "专注时锁住"),
    h("p", { class: "hint" }, "被锁的 App 一跳到前台就会被藏起来。想看的话右键宠物「解锁 5 分钟」。"),
    apps,
    h("h3", null, "同时打开系统勿扰（可选）"),
    h(
      "p",
      { class: "hint" },
      "macOS 不让 App 直接开关勿扰，要借助「快捷指令」：新建一个快捷指令，加入「设定专注模式」动作并选「勿扰模式 · 打开」，命名为「StudyPet 专注开始」；再建一个「关闭」的，叫「StudyPet 专注结束」。",
    ),
    shortcut("开始时运行", settings.dndOn, "dndOn", "StudyPet 专注开始"),
    shortcut("结束时运行", settings.dndOff, "dndOff", "StudyPet 专注结束"),
  );
}

function nameField(current: string, error: HTMLElement): HTMLElement {
  const input = h("input", { type: "text", value: current, maxlength: 24, "aria-label": "宠物的名字" });
  input.addEventListener("change", async () => {
    try {
      await invoke("rename_pet", { name: input.value }); // emits pet-changed → re-render
    } catch (e) {
      error.textContent = errorText(e);
    }
  });
  return h("label", { class: "field" }, h("span", null, "名字"), input);
}
