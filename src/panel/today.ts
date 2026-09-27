// "What's on": open deadlines for this week (missed ones after, gently), later ones folded,
// then classes and other events day by day.
import { DAY, HOUR, isOptionalEvent, openDeadlines, outlook } from "../shared/agenda";
import { emit, errorText, invoke } from "../shared/bridge";
import { ago, dayHeading, dayOffset, dueText, hm, meetingName, relative, splitLocation } from "../shared/format";
import * as lines from "../shared/lines";
import { getDone, getItems, getSources, keys, store } from "../shared/store";
import { edCourseUrl } from "../shared/ed";
import { isGradescopeUrl } from "../shared/gradescope";
import { openService } from "../shared/services";
import { getEdCourses, getNotices, syncAll } from "../shared/sync";
import type { EdCourse, EdRegion, Item, Notice, PetInfo } from "../shared/types";
import type { PetView } from "../pet/sprite";
import { button, h, openLink, petPreview } from "./dom";
import type { Nav } from "./main";

export async function renderToday(root: HTMLElement, nav: Nav): Promise<() => void> {
  const kv = await store();
  const [items, done, sources, lastSync, pet, notices, edCourses] = await Promise.all([
    getItems(),
    getDone(),
    getSources(),
    kv.get<number>(keys.lastSync),
    invoke<PetInfo | null>("get_pet"),
    getNotices(),
    getEdCourses(),
  ]);
  const now = Date.now();
  const o = outlook(items, done, now);

  let avatar: PetView | null = null;
  if (pet) {
    avatar = await petPreview(pet, 64).catch(() => null);
    avatar?.setBase(o.level === "urgent" ? "running" : o.level === "soon" || o.level === "overdue" ? "waiting" : "idle");
  }
  root.append(
    h(
      "header",
      { class: "today-head" },
      h("div", { class: "avatar" }, avatar?.el),
      h("div", null, h("div", { class: "date" }, dayHeading(now, now)), h("p", { class: "summary" }, lines.summary(o, now))),
    ),
  );

  if (!sources.length) {
    root.append(
      h(
        "div",
        { class: "empty-card" },
        h("strong", null, "还没有连接日历"),
        h("p", null, "连上 Canvas 之后，我会在截止前提醒你，上课前叫你出发。"),
        button("去连接 Canvas", () => nav.go("settings"), "btn primary"),
      ),
    );
    return () => avatar?.destroy();
  }

  // Deadlines: this week up front, the rest folded away so the list stays calm.
  const allOpen = openDeadlines(items, done);
  const open = allOpen.filter((i) => i.start >= now - 3 * DAY && i.start <= now + 7 * DAY);
  const missed = open.filter((i) => i.start < now);
  const upcoming = open.filter((i) => i.start >= now);
  const later = allOpen.filter((i) => i.start > now + 7 * DAY);
  // Ticked off here in the last week, or submitted on Gradescope (due in the last week or later).
  const finished = items
    .filter(
      (i) =>
        i.kind === "deadline" &&
        ((done[i.id] && now - done[i.id] < 7 * DAY) || (i.submitted && i.start >= now - 7 * DAY)),
    )
    .sort((a, b) => (done[b.id] ?? b.start) - (done[a.id] ?? a.start));

  const tasks = h("ul", { class: "tasks" }, [...upcoming, ...missed].map((i) => taskRow(i, now, false)));
  root.append(
    h(
      "section",
      { class: "block" },
      h("h2", null, "这周要交的", h("span", { class: "count" }, open.length || "")),
      open.length ? tasks : h("p", { class: "quiet" }, "未来 7 天没有要交的 🎉"),
      missed.length
        ? h("p", { class: "hint" }, "过了截止时间的先别慌：很多课允许迟交，或者可以给老师发邮件说明一下情况。")
        : null,
      later.length
        ? h(
            "details",
            { class: "later" },
            h("summary", null, `之后还有 ${later.length} 个`),
            h("ul", { class: "tasks" }, later.map((i) => taskRow(i, now, false))),
          )
        : null,
      finished.length
        ? h(
            "details",
            { class: "finished" },
            h("summary", null, `最近完成的（${finished.length}）`),
            h("ul", { class: "tasks" }, finished.map((i) => taskRow(i, now, true))),
          )
        : null,
    ),
  );

  const ed = sources.find((s) => s.kind === "ed");
  if (ed) root.append(edBlock(notices, edCourses, ed.region ?? "us", now));

  // Events, grouped by day
  const events = items.filter((i) => i.kind === "event" && (i.end ?? i.start) >= now && i.start <= now + 7 * DAY);
  if (events.length) {
    const days = new Map<number, Item[]>();
    for (const e of events) {
      const off = dayOffset(e.start, now);
      days.set(off, [...(days.get(off) ?? []), e]);
    }
    root.append(
      h(
        "section",
        { class: "block" },
        h("h2", null, "日程"),
        [...days.entries()].map(([, list]) =>
          h("div", { class: "day" }, h("h3", null, dayHeading(list[0].start, now)), h("ul", { class: "events" }, list.map(eventRow))),
        ),
      ),
    );
  }

  // Footer: sync status
  const syncStatus = h("span", null, lastSync ? `上次同步：${ago(lastSync, now)}` : "还没同步过");
  const refresh = button("刷新", async () => {
    refresh.disabled = true;
    syncStatus.textContent = "同步中…";
    try {
      await syncAll(); // emits data-updated, which re-renders this view
    } catch (e) {
      syncStatus.textContent = `同步失败：${errorText(e)}`;
      refresh.disabled = false;
    }
  }, "btn small");
  const failing = sources.filter((s) => s.lastError);
  root.append(
    h(
      "footer",
      { class: "sync" },
      syncStatus,
      refresh,
      failing.length
        ? h(
            "p",
            { class: "bad" },
            `${failing.map((s) => s.name).join("、")} 同步失败，`,
            h("button", { class: "btn link", type: "button", onclick: () => nav.go("settings") }, "去设置里看看"),
          )
        : null,
    ),
  );

  return () => avatar?.destroy();
}

function taskRow(i: Item, now: number, isDone: boolean): HTMLElement {
  const wait = i.start - now;
  const tone = isDone ? "done" : wait < 0 ? "missed" : wait <= 3 * HOUR ? "urgent" : wait <= DAY ? "soon" : "later";
  const row = h("li", { class: `task ${tone}` });
  const check: HTMLInputElement = h("input", {
    type: "checkbox",
    checked: isDone,
    "aria-label": `${isDone ? "取消完成" : "标记完成"}：${i.title}`,
    onchange: () => {
      row.classList.toggle("done", check.checked);
      window.setTimeout(() => void setDone(i, check.checked), 350);
    },
  });
  // Gradescope knows whether it was submitted, so there's nothing to tick by hand.
  const mark = i.submitted
    ? h("span", { class: "check submitted", title: "已在 Gradescope 提交", "aria-label": "已提交" }, "✓")
    : h("label", { class: "check" }, check);
  row.append(
    mark,
    h(
      "div",
      { class: "task-main" },
      h("div", { class: "task-title" }, i.title),
      h(
        "div",
        { class: "task-meta" },
        i.courseShort ? h("span", { class: "chip", title: i.course }, i.courseShort) : null,
        h("span", null, dueText(i.start, now)),
        isDone ? null : h("span", { class: "rel" }, wait < 0 ? "已过截止时间" : relative(i.start, now)),
        i.lateDue && !isDone ? h("span", null, `迟交截止 ${dueText(i.lateDue, now)}`) : null,
        i.submitted ? h("span", { class: "tag-ok" }, "已提交") : null,
      ),
    ),
  );
  const url = i.url;
  if (url && isGradescopeUrl(url)) {
    row.append(
      button(i.submitted ? "查看" : "去提交", () => openService("gradescope", url), `btn small ${i.submitted ? "" : "submit"}`),
    );
  } else if (url) {
    row.append(
      h("button", { class: "icon", type: "button", title: "在 Canvas 里打开", "aria-label": "在 Canvas 里打开", onclick: () => openLink(url) }, "↗"),
    );
  }
  return row;
}

function eventRow(e: Item): HTMLElement {
  const time = e.allDay ? "全天" : `${hm(e.start)}${e.end ? `–${hm(e.end)}` : ""}`;
  const place = splitLocation(e.location);
  const link = place.url;
  return h(
    "li",
    { class: isOptionalEvent(e) ? "optional" : "" },
    h("span", { class: "time" }, time),
    h(
      "div",
      { class: "event-main" },
      h("div", { class: "event-title" }, e.courseShort && !e.title.includes(e.courseShort) ? `${e.title} · ${e.courseShort}` : e.title),
      place.text ? h("div", { class: "event-loc" }, place.text) : null,
    ),
    link
      ? h("button", { class: "btn small link-out", type: "button", title: link, onclick: () => openLink(link) }, `${meetingName(link)} ↗`)
      : null,
  );
}

async function setDone(item: Item, isDone: boolean) {
  const done = await getDone();
  if (isDone) done[item.id] = Date.now();
  else delete done[item.id];
  await (await store()).set(keys.done, done);
  await emit("done-changed", { id: item.id, done: isDone });
}

/** Ed: unread counts per course and the latest announcements. */
function edBlock(notices: Notice[], courses: EdCourse[], region: EdRegion, now: number): HTMLElement {
  const open = (url?: string) => () => openService("ed", url);
  return h(
    "section",
    { class: "block" },
    h("h2", null, "Ed", h("button", { class: "btn small push", type: "button", onclick: open() }, "打开 Ed")),
    courses.length
      ? h(
          "div",
          { class: "ed-courses" },
          courses.map((c) =>
            h(
              "button",
              { class: `ed-course${c.unseen ? " unread" : ""}`, type: "button", title: c.name, onclick: open(edCourseUrl(region, c.id)) },
              c.code,
              c.unseen ? h("span", { class: "count" }, c.unseen) : null,
            ),
          ),
        )
      : null,
    notices.length
      ? h(
          "ul",
          { class: "notices" },
          notices.slice(0, 6).map((n) =>
            h(
              "li",
              { class: n.seen ? "" : "unseen" },
              h(
                "button",
                { class: "notice", type: "button", onclick: open(n.url) },
                h("span", { class: "notice-title" }, n.title),
                h("span", { class: "notice-meta" }, `${n.course} · ${ago(n.createdAt, now)}`),
              ),
            ),
          ),
        )
      : h("p", { class: "quiet" }, "最近三周没有新公告"),
  );
}
