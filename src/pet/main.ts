// The pet window: a transparent, always-on-top window holding the pet, its speech bubble,
// a badge, a timer pill and (when tucked at an edge) a dot. This page is also the app's
// "brain": it syncs, watches the clock, and decides when the pet should say something.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { DAY, HOUR, openDeadlines, outlook, remindableEvents, type Level, type Outlook } from "../shared/agenda";
import { errorText, inTauri, invoke, listen, log } from "../shared/bridge";
import { DEFAULT_GRADESCOPE_SITE, gradescopeSiteOf, isGradescopeUrl } from "../shared/gradescope";
import { openService as openServiceWindow } from "../shared/services";
import * as lines from "../shared/lines";
import { getDone, getItems, getSettings, getSources, keys, store, type DoneMap } from "../shared/store";
import { connectGradescope, getNotices, syncAll } from "../shared/sync";
import { DEFAULT_SETTINGS, type Item, type Notice, type PetInfo, type Session, type Settings } from "../shared/types";
import { Motion, type Side } from "./motion";
import { Health, Sessions } from "./sessions";
import { createPetView, type Anim, type PetView } from "./sprite";

/** Hours before a deadline at which the pet speaks up. */
const REMIND_AT_H = [72, 24, 3];
const SYNC_EVERY = 30 * 60_000;
const TICK_MS = 20_000;
/** Unprompted chatter (not deadline alarms) at most this often. */
const QUIET_GAP = 8 * 60_000;

/** Posture per urgency level — the pet's first way of telling you how things stand. */
const MOOD: Record<Level, Anim> = {
  empty: "idle",
  calm: "idle",
  "heads-up": "idle",
  overdue: "waiting",
  soon: "waiting",
  urgent: "running",
};

type Action = { label: string; run: () => void };

const stage = document.getElementById("stage")!;
const petBox = el("div", "pet");
const bubble = el("div", "bubble");
const bubbleText = el("span", "text");
const bubbleCta = el("span", "cta");
const badge = el("div", "badge");
const timer = el("button", "timer");
const dot = el("button", "peek-dot");
bubble.append(bubbleText, bubbleCta);
stage.append(bubble, petBox, badge, timer, dot);

let view: PetView;
let pet: PetInfo;
let settings: Settings = DEFAULT_SETTINGS;
let items: Item[] = [];
let done: DoneMap = {};
let notices: Notice[] = [];
let current: Outlook = outlook([], {});
/** Items as of the previous refresh — to notice "just submitted on Gradescope". */
let prevItems = new Map<string, Item>();
/** Ed announcements already seen by the pet; null until Ed data first arrives. */
let knownNotices: Set<string> | null = null;
/** What clicking the current bubble does (e.g. open the Gradescope submit page). */
let bubbleAction: (() => void) | null = null;
/** The last thing the pet wanted to say while tucked away (meeting mode). */
let missed: string | undefined;
let lastTick = Date.now();
let lastSync = 0;
let lastProactive = 0;
let nightNudged = "";
/** Pet box and body in window CSS px, set by layout(). */
let petRect = { x: 0, y: 0 };
let body = { x: 0, y: 0, w: 0, h: 0 };
/** CSS px the pet is raised inside the window (near the top of the screen, see motion.ts). */
let lift = 0;

const motion = new Motion({
  body: () => body,
  maxLift: () => Math.max(0, Math.round((stage.clientHeight - view.height) / 2) - 4),
  setLift: (px) => {
    lift = px;
    layout();
  },
  onDragStart: () => hideBubble(),
  onDragMove: (dir) => view.setMoving(dir),
  onTuck: (side) => void onTuck(side),
  holdMouse: (on) => {
    if (!inTauri) return;
    if (on) void invoke("set_hit_regions", { rects: [{ x: -20000, y: -20000, w: 40000, h: 40000 }] });
    else updateHitRegions();
  },
});

const sessions = new Sessions({
  settings: () => settings,
  say: (text, action) => speak(text, action),
  celebrate: () => play("jumping", 2),
  // You asked for a timer: come out of meeting mode to show it.
  showUp: () => motion.untuck(),
  changed: (s) => onSessionChanged(s),
});

const health = new Health({
  settings: () => settings,
  quiet: () => sessions.focusing || !!motion.tucked,
  nudge: (text) => speakUp(text, "waving"),
});

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = cls;
  return node;
}

async function main() {
  if (!inTauri) document.body.classList.add("preview");
  await listen("pet-changed", () => location.reload());
  await listen("settings-changed", () => location.reload());

  const info = await invoke<PetInfo | null>("get_pet");
  if (!info) {
    log("pet: no pet yet — waiting for onboarding");
    return;
  }
  pet = info;
  lines.setPetName(info.name);
  settings = await getSettings();
  try {
    const bytes = await invoke<ArrayBuffer>("get_pet_image");
    const url = URL.createObjectURL(new Blob([bytes], { type: info.mime }));
    view = await createPetView(info.kind, url, Math.min(150, Math.max(80, settings.petSize)), info.mode);
  } catch (e) {
    // Don't sit invisible: send the user to pick another pet.
    log("pet: couldn't load the pet image:", errorText(e));
    await invoke("show_panel", { view: "settings" });
    return;
  }
  petBox.append(view.el);
  layout();
  log(`pet: ${info.name} (${info.kind}) ${view.width}×${view.height}${view.features.length ? ` · ${view.features.join(" · ")}` : ""}`);

  await refresh();
  wireInput();
  await wireEvents();

  if (inTauri) {
    await motion.place();
    await getCurrentWindow().show();
  } else if (import.meta.env.DEV) {
    (await import("../dev/preview")).mountPreview({
      view,
      speak,
      setLevel: previewLevel,
      tuck: (side) => {
        motion.tucked = side;
        void onTuck(side);
      },
      pomodoro: () => void sessions.startPomodoro(settings.pomodoro.focusMin),
      focus: () => void sessions.startFocus(),
      stop: () => void sessions.stop(),
      bubbleBelow: (on) => {
        speak("看看远处 20 秒，让眼睛歇一歇～");
        bubble.classList.toggle("below", on);
      },
    });
  }
  await sessions.restore();

  const onboarded = (await (await store()).get<boolean>(keys.onboarded)) ?? false;
  window.setTimeout(() => {
    play("waving", 2);
    speak(onboarded ? lines.greeting(current) : lines.welcome(pet.name));
  }, 900);

  lastTick = Date.now();
  window.setInterval(() => void tick(), TICK_MS);

  if (import.meta.env.DEV) {
    const selftest = await invoke<string | null>("selftest_ics_url");
    if (selftest) void selfTest(selftest);
  }
}

// ---------------------------------------------------------------------------
// Layout: the pet sits in the middle of a tall window, with room for the bubble above or below.

function layout() {
  const W = stage.clientWidth;
  const H = stage.clientHeight;
  petRect = { x: Math.round((W - view.width) / 2), y: Math.round((H - view.height) / 2 - lift) };
  petBox.style.left = `${petRect.x}px`;
  petBox.style.top = `${petRect.y}px`;
  body = {
    x: petRect.x + view.body.x,
    y: petRect.y + view.body.y,
    w: view.body.w,
    h: view.body.h,
  };
  bubble.style.setProperty("--above", `${H - body.y + 6}px`);
  bubble.style.setProperty("--below", `${body.y + body.h + 8}px`);
  badge.style.left = `${Math.round(body.x + body.w - 10)}px`;
  badge.style.top = `${Math.round(body.y - 6)}px`;
  timer.style.left = `${Math.round(body.x + body.w / 2)}px`;
  timer.style.top = `${Math.round(body.y + body.h + 4)}px`;
  updateHitRegions();
}

/** Tells Rust which parts of the window are "solid"; everything else is click-through. */
function updateHitRegions() {
  if (!view) return;
  const pad = 4;
  const rects: { x: number; y: number; w: number; h: number }[] = [];
  if (motion.tucked) {
    // Only the sliver still on screen (and the dot) take clicks.
    const r = dot.getBoundingClientRect();
    rects.push({ x: r.x - pad, y: body.y, w: r.width + 2 * pad, h: body.h });
  } else {
    rects.push({ x: body.x - pad, y: body.y - pad, w: body.w + 2 * pad, h: body.h + 2 * pad });
    for (const node of [bubble, badge, timer]) {
      if (!node.classList.contains("show")) continue;
      // Measured mid-transition (the bubble scales in), so leave some slack.
      const r = node.getBoundingClientRect();
      rects.push({ x: r.x - 2 * pad, y: r.y - 2 * pad, w: r.width + 4 * pad, h: r.height + 4 * pad });
    }
  }
  if (inTauri) void invoke("set_hit_regions", { rects });
}

// ---------------------------------------------------------------------------
// Speaking

let bubbleTimer = 0;

function speak(text: string, action?: Action, ms = Math.min(12_000, 4_000 + text.length * 90)) {
  if (motion.tucked) {
    // Meeting mode: stay silent, remember the last thing, and let the dot hint at it.
    missed = text;
    dot.classList.add("news");
    return;
  }
  bubbleText.textContent = text;
  bubbleCta.textContent = action ? action.label : "";
  bubbleAction = action?.run ?? null;
  // Below the pet when it's too close to the top of the screen for the bubble to fit above.
  bubble.classList.toggle("below", motion.roomAbove() < bubble.offsetHeight + 30);
  bubble.classList.add("show");
  window.clearTimeout(bubbleTimer);
  bubbleTimer = window.setTimeout(hideBubble, ms);
  requestAnimationFrame(updateHitRegions);
}

function hideBubble() {
  window.clearTimeout(bubbleTimer);
  bubble.classList.remove("show");
  bubbleAction = null;
  requestAnimationFrame(updateHitRegions);
}

function play(anim: Anim, loops = 1) {
  if (!motion.tucked) void view.play(anim, loops);
}

/** Unprompted remarks respect a quiet gap and focus sessions; `force` is for deadline and class alarms. */
function speakUp(text: string, anim: Anim, force = false, action?: Action) {
  const now = Date.now();
  if (!force && (now - lastProactive < QUIET_GAP || sessions.focusing)) {
    log("pet: holding back:", text);
    return;
  }
  lastProactive = now;
  play(anim, 2);
  speak(text, action);
}

/** Where clicking a bubble about this item should go: Gradescope's submit page, or the Canvas page. */
function actionFor(item: Item): Action | undefined {
  const url = item.url;
  if (!url) return undefined;
  if (isGradescopeUrl(url)) {
    return { label: item.submitted ? "去看看提交 →" : "点我直接去交 →", run: () => void openService("gradescope", url) };
  }
  return { label: "打开 Canvas →", run: () => void openUrl(url) };
}

function openService(name: "gradescope" | "ed", url?: string) {
  return openServiceWindow(name, url).catch((e) => log("open_service failed:", errorText(e)));
}

// ---------------------------------------------------------------------------
// State → posture, badge, dot

let lastLevel: Level | null = null;

function applyMood() {
  current = outlook(items, done);
  // A deadline just slipped by: a moment of dismay (not on launch, not while focusing).
  if (current.level === "overdue" && lastLevel !== null && lastLevel !== "overdue" && !sessions.focusing) play("failed");
  lastLevel = current.level;
  view.setBase(sessions.focusing ? "review" : MOOD[current.level]);
  const count = current.within24h.length;
  badge.dataset.level = current.level;
  dot.dataset.level = current.level;
  if (current.level === "soon" || current.level === "urgent") badge.textContent = String(count);
  else if (current.level === "overdue") badge.textContent = "!";
  const open = openDeadlines(items, done).filter((i) => i.start >= Date.now() - 3 * DAY && i.start <= Date.now() + 7 * DAY);
  // Tucked away during a pomodoro or focus session, the dot keeps the time instead.
  const s = sessions.current;
  dot.dataset.session = s?.kind ?? "";
  if (s?.kind === "pomodoro" || s?.kind === "break") {
    const minutes = Math.ceil(((s.endsAt ?? Date.now()) - Date.now()) / 60_000);
    dot.textContent = s.kind === "break" ? "☕" : `${minutes}′`;
    dot.title = `${s.kind === "break" ? "休息" : "番茄钟"}还剩 ${sessions.remaining()}`;
  } else if (s?.kind === "focus") {
    dot.textContent = "🔒";
    dot.title = `专注了 ${sessions.elapsed()}`;
  } else {
    dot.textContent = open.length ? String(open.length) : "";
    dot.title = open.length ? `这周还有 ${open.length} 个要交` : "这周没有要交的";
  }
  const show = !motion.tucked && ["soon", "urgent", "overdue"].includes(current.level);
  if (show !== badge.classList.contains("show")) {
    badge.classList.toggle("show", show);
    updateHitRegions();
  }
}

async function refresh() {
  [items, done, notices] = await Promise.all([getItems(), getDone(), getNotices()]);

  // Submitted on Gradescope since the last look → celebrate.
  const justSubmitted = items.find((i) => i.submitted && prevItems.get(i.id)?.submitted === false);
  prevItems = new Map(items.map((i) => [i.id, i]));
  if (justSubmitted) {
    play("jumping", 2);
    speak(lines.submittedOnGradescope(justSubmitted));
  }

  // New Ed announcements (not on the first load, so connecting Ed doesn't replay history).
  if (knownNotices) {
    const fresh = notices.filter((n) => !knownNotices!.has(n.id) && !n.seen);
    if (fresh.length && !justSubmitted) {
      const first = fresh[0];
      speakUp(lines.edAnnouncement(first, fresh.length - 1), "waving", true, {
        label: "去 Ed 看看 →",
        run: () => void openService("ed", first.url),
      });
    }
  }
  if (notices.length || knownNotices) knownNotices = new Set(notices.map((n) => n.id));
  applyMood();
}

function onSessionChanged(s: Session | null) {
  const left = sessions.remaining();
  const label = !s ? "" : s.kind === "pomodoro" ? `🍅 ${left}` : s.kind === "break" ? `☕ ${left}` : `🔒 专注 ${sessions.elapsed()}`;
  timer.textContent = label;
  timer.dataset.kind = s?.kind ?? "";
  // The pill fills up as the pomodoro (or break) goes by.
  timer.style.setProperty("--done", `${(sessions.progress() * 100).toFixed(1)}%`);
  const show = !!s && !motion.tucked;
  if (show !== timer.classList.contains("show")) {
    timer.classList.toggle("show", show);
    document.body.classList.toggle("has-timer", show);
    updateHitRegions();
  }
  if (s?.kind === "break") health.reset();
  applyMood();
}

async function onTuck(side: Side | null) {
  document.body.dataset.tucked = side ?? "";
  view.freeze(!!side);
  hideBubble();
  if (side) {
    // The dot sits in the middle of the visible sliver.
    const x = side === "left" ? body.x + body.w - 9 : body.x + 9;
    dot.style.left = `${Math.round(x)}px`;
    dot.style.top = `${Math.round(body.y + body.h * 0.3)}px`;
    dot.classList.add("show");
    badge.classList.remove("show");
    timer.classList.remove("show");
    log(`pet: tucked ${side} (meeting mode)`);
  } else {
    dot.classList.remove("show", "news");
    const note = missed;
    missed = undefined;
    speak(lines.backFromMeeting(note));
    onSessionChanged(sessions.current);
  }
  applyMood();
  requestAnimationFrame(updateHitRegions);
}

// ---------------------------------------------------------------------------
// Clock: sync, reminders, health

let ticking = false;
/** After a failed sync (often: no network yet after waking up), try again soon, backing off. */
let retryDelay = 0;
let retryAt = 0;

async function tick() {
  // Timers held back during sleep can fire all at once on wake: one tick at a time.
  if (ticking) return;
  ticking = true;
  try {
    const now = Date.now();
    const slept = now - lastTick > 3 * 60_000;
    const r = dueReminder(lastTick, now);
    lastTick = now;
    applyMood();
    if (r) speakUp(r.text, r.anim, r.force, r.item && actionFor(r.item));
    else await health.check(now);
    // The panel can sync too, so go by the shared timestamp.
    const synced = Math.max(lastSync, (await (await store()).get<number>(keys.lastSync)) ?? 0);
    if (slept) await sync("wake");
    else if (now - synced > SYNC_EVERY) await sync("interval");
    else if (retryAt && now >= retryAt) await sync("retry");
  } finally {
    ticking = false;
  }
}

let serviceTimer = 0;
let lastServiceSync = 0;

/**
 * A page finished loading in the Gradescope / Ed window: maybe a fresh login (connect),
 * a new submission, or a thread just read (re-sync, at most every 30s).
 */
function onServicePage(service: string, url: string) {
  window.clearTimeout(serviceTimer);
  serviceTimer = window.setTimeout(async () => {
    let path = "";
    try {
      path = new URL(url).pathname;
    } catch {
      return;
    }
    if (service === "gradescope") {
      if (/login|saml|sso|auth/i.test(path)) return;
      // Connect on first login — and follow the user to another regional site if they log in there.
      const site = gradescopeSiteOf(url);
      const connected = (await getSources()).find((s) => s.kind === "gradescope");
      if (site && (!connected || (connected.site ?? DEFAULT_GRADESCOPE_SITE) !== site)) {
        const count = await connectGradescope(site).catch((e) => (log("gradescope connect:", errorText(e)), null));
        if (count !== null) {
          play("jumping", 2);
          speak(lines.gradescopeConnected(count));
        }
        return;
      }
    }
    if (Date.now() - lastServiceSync < 30_000) return;
    lastServiceSync = Date.now();
    await sync(`${service} page`);
  }, 2_000);
}

async function sync(reason: string, announce = false) {
  lastSync = Date.now();
  try {
    const r = await syncAll();
    log(`sync (${reason}):`, r);
    retryDelay = r.failed ? Math.min(SYNC_EVERY, retryDelay ? retryDelay * 2 : 2 * 60_000) : 0;
    retryAt = retryDelay ? Date.now() + retryDelay : 0;
    if (announce) speak(r.failed ? "有来源没同步成功，去面板里看看？" : "同步好啦～");
  } catch (e) {
    log("sync failed:", errorText(e));
  }
  await refresh();
}

/**
 * What to say for thresholds crossed between two ticks. Comparing against the previous
 * tick (not "now ± interval") means reminders missed while the laptop slept still fire
 * once on wake, and never twice.
 */
function dueReminder(prev: number, now: number): { text: string; anim: Anim; force: boolean; item?: Item } | null {
  let best: { item: Item; h: number } | null = null;
  for (const d of openDeadlines(items, done)) {
    if (d.start <= now) continue;
    const crossed = REMIND_AT_H.filter((h) => d.start - prev > h * HOUR && d.start - now <= h * HOUR);
    if (!crossed.length) continue;
    const h = Math.min(...crossed);
    if (!best || h < best.h || (h === best.h && d.start < best.item.start)) best = { item: d, h };
  }
  if (best && best.h <= 3) return { text: lines.remind(best.item, best.h, now), anim: "running", force: true, item: best.item };

  const lead = settings.classLeadMin * 60_000;
  const cls = remindableEvents(items, now, now + lead).find((e) => e.start - prev > lead);
  if (cls) {
    const minutes = Math.max(1, Math.round((cls.start - now) / 60_000));
    return { text: lines.classSoon(cls, minutes), anim: "waving", force: true };
  }
  if (best) return { text: lines.remind(best.item, best.h, now), anim: "waving", force: true, item: best.item };

  // Up late with an early class: one gentle nudge per night.
  const d = new Date(now);
  const night = d.toDateString();
  if (d.getHours() >= 1 && d.getHours() < 4 && nightNudged !== night) {
    const eleven = new Date(now);
    eleven.setHours(11, 0, 0, 0);
    const early = remindableEvents(items, now + HOUR, eleven.getTime())[0];
    if (early) {
      nightNudged = night;
      return { text: lines.nightNudge(early, now), anim: "waiting", force: false };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Input: click, double-click, drag, right-click, cursor

let clicks = 0;
let clickReset = 0;
let recentQuips: string[] = [];

/** 1st click: the next deadline. 2nd: the one after. Then the user's random lines. */
function onClick() {
  if (motion.tucked) return void invoke("show_panel", { view: "today" });
  clicks += 1;
  window.clearTimeout(clickReset);
  clickReset = window.setTimeout(() => (clicks = 0), 30_000);
  play("waving");
  if (clicks <= 2) {
    const now = Date.now();
    const upcoming = openDeadlines(items, done).filter((i) => i.start >= now);
    const item = upcoming[clicks - 1];
    if (item) return speak(lines.nextUp(item, clicks - 1, now), actionFor(item));
    if (clicks === 1) {
      return speak(current.level === "empty" || current.level === "overdue" ? lines.summary(current) : lines.nothingNext(0));
    }
  }
  speak(randomQuip());
}

function randomQuip(): string {
  const pool = settings.quips?.length ? settings.quips : lines.DEFAULT_QUIPS;
  const candidates = pool.filter((q) => !recentQuips.includes(q));
  const choices = candidates.length ? candidates : pool;
  const quip = choices[Math.floor(Math.random() * choices.length)];
  recentQuips = [quip, ...recentQuips].slice(0, Math.max(0, Math.min(6, pool.length - 1)));
  return quip;
}

function wireInput() {
  let press: MouseEvent | null = null;
  let clickTimer = 0;

  const down = (e: MouseEvent) => {
    if (e.button === 0) press = e;
  };
  petBox.addEventListener("mousedown", down);
  dot.addEventListener("mousedown", down);
  window.addEventListener("mousemove", (e) => {
    if (!press || Math.hypot(e.screenX - press.screenX, e.screenY - press.screenY) < 4) return;
    const start = press;
    press = null;
    window.clearTimeout(clickTimer);
    clickTimer = 0;
    motion.beginDrag(start);
  });
  window.addEventListener("mouseup", (e) => {
    if (!press || e.button !== 0) return;
    press = null;
    if (clickTimer) {
      window.clearTimeout(clickTimer);
      clickTimer = 0;
      hideBubble();
      void invoke("show_panel", { view: "today" });
      return;
    }
    clickTimer = window.setTimeout(() => {
      clickTimer = 0;
      onClick();
    }, 250);
  });
  for (const node of [petBox, timer, dot]) {
    node.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      void showMenu();
    });
  }
  timer.addEventListener("click", () => void showMenu());
  bubble.addEventListener("click", () => {
    const action = bubbleAction;
    hideBubble();
    if (action) action();
    else void invoke("show_panel", { view: "today" });
  });
}

/** The right-click menu (built natively; a click comes back as a "pet-menu" event). */
async function showMenu() {
  hideBubble();
  if (!inTauri) return;
  const s = sessions.current;
  await invoke("show_pet_menu", {
    state: { session: s?.kind ?? null, locked: !!s?.lock, tucked: !!motion.tucked, focusMin: settings.pomodoro.focusMin },
  }).catch((e) => log("menu:", errorText(e)));
}

const MENU_ACTIONS: Record<string, () => unknown> = {
  today: () => invoke("show_panel", { view: "today" }),
  sync: () => sync("manual", true),
  pomo: () => sessions.startPomodoro(settings.pomodoro.focusMin),
  pomo2: () => sessions.startPomodoro(settings.pomodoro.focusMin * 2),
  focus: () => sessions.startFocus(),
  stop: () => sessions.stop(),
  unlock: () => sessions.unlockFor(5),
  gradescope: () => openService("gradescope"),
  ed: () => openService("ed"),
  untuck: () => motion.untuck(),
  settings: () => invoke("show_panel", { view: "settings" }),
  hide: () => invoke("set_pet_visible", { visible: false }),
  quit: () => invoke("quit_app"),
};

async function wireEvents() {
  await listen<string>("pet-menu", (id) => {
    log(`menu: ${id}`);
    void Promise.resolve(MENU_ACTIONS[id]?.()).catch((e) => log(`menu ${id} failed:`, errorText(e)));
  });
  await listen("data-updated", () => void refresh());
  await listen("sync-request", () => void sync("panel"));
  await listen<[string, string]>("service-page", ([service, url]) => onServicePage(service, url));
  await listen<string>("focus-blocked", (app) =>
    speak(lines.blocked(app), { label: "解锁 5 分钟 →", run: () => void sessions.unlockFor(5) }),
  );
  await listen("onboarded", async () => {
    await refresh();
    play("waving", 2);
    speak(lines.greeting(current));
  });
  await listen<{ id: string; done: boolean }>("done-changed", async ({ id, done: isDone }) => {
    await refresh();
    if (isDone) {
      play("jumping", 2);
      speak(lines.celebrate(items.find((i) => i.id === id)));
    }
  });

  // The pet watches the cursor wherever it goes (positions come from the Rust hit-test loop),
  // and looks back at you once the mouse has rested for a few seconds.
  let lookTimer = 0;
  await listen<[number, number]>("pet-cursor", ([x, y]) => {
    if (motion.tucked) return;
    view.look({ x: x - (body.x + body.w / 2), y: y - (body.y + body.h * 0.4) });
    window.clearTimeout(lookTimer);
    lookTimer = window.setTimeout(() => view.look(null), 6_000);
  });
}

// ---------------------------------------------------------------------------
// Dev helpers

/** Browser preview only: fake an urgency level. */
function previewLevel(level: Level) {
  const now = Date.now();
  const at: Partial<Record<Level, number>> = { urgent: now + 2 * HOUR, soon: now + 20 * HOUR, "heads-up": now + 40 * HOUR, calm: now + 5 * DAY, overdue: now - 5 * HOUR };
  const due = at[level];
  items =
    due === undefined
      ? []
      : [{ id: "preview", sourceId: "preview", kind: "deadline", title: "Problem Set 3", course: "ECON 101", courseShort: "ECON 101", start: due, allDay: false }];
  done = {};
  applyMood();
  speak(lines.summary(current));
}

/** `STUDYPET_SELFTEST_ICS=<url> npm run tauri dev` — end-to-end check of keychain + fetch + parse. */
async function selfTest(url: string) {
  const id = "selftest";
  log("selftest: begin", url);
  try {
    await invoke("source_save", { id, url });
    await (await store()).set(keys.sources, [{ id, name: "Self test", kind: "canvas", addedAt: Date.now() }]);
    const r = await syncAll();
    await refresh();
    log("selftest: sync", r);
    log("selftest: level", current.level, "| next", current.next?.title ?? "-", "| within24h", current.within24h.length, "| overdue", current.overdue.length);
    log("selftest: items", items.map((i) => `${i.kind}:${i.title}@${new Date(i.start).toISOString()}`).join(" ; "));
    log("selftest: reminder preview:", dueReminder(Date.now() - 4 * DAY, Date.now())?.text ?? "(none)");
    log("selftest: pet view", view.width, view.height, JSON.stringify(view.body));
  } catch (e) {
    log("selftest: FAILED", errorText(e));
  } finally {
    await invoke("source_delete", { id }).catch((e) => log("selftest: delete failed", errorText(e)));
    log("selftest: keychain entry removed");
  }
}

main().catch((e) => log("pet: fatal", errorText(e)));
