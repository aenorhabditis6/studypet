// .ics → Items. Handles Canvas calendar feeds (assignments become deadlines) and ordinary
// calendars such as Google / Outlook / school timetables (recurring classes are expanded).
import ICAL from "ical.js";
import type { Counts, Item, SourceKind } from "./types";

type IcalEvent = InstanceType<typeof ICAL.Event>;
type IcalTime = InstanceType<typeof ICAL.Time>;

const MIN = 60_000;
const DAY = 86_400_000;
/** Keep a few days of the past so recently missed deadlines can still be handled gently. */
const KEEP_PAST = 3 * DAY;
const KEEP_FUTURE = 60 * DAY;
/** Recurring events (classes) are only expanded this far ahead. */
const EXPAND_FUTURE = 21 * DAY;

export interface ParsedFeed {
  calName?: string;
  items: Item[];
}

export function parseIcs(text: string, sourceId: string, kind: SourceKind, now = Date.now()): ParsedFeed {
  const root = new ICAL.Component(ICAL.parse(text));
  for (const tz of root.getAllSubcomponents("vtimezone")) {
    try {
      ICAL.TimezoneService.register(tz);
    } catch {
      // A malformed zone only means those times are read as local time.
    }
  }

  // Occurrences moved or cancelled individually arrive as separate VEVENTs with a RECURRENCE-ID.
  const masters = new Map<string, IcalEvent>();
  const exceptions: IcalEvent[] = [];
  root.getAllSubcomponents("vevent").forEach((comp, i) => {
    const ev = new ICAL.Event(comp);
    if (ev.isRecurrenceException()) exceptions.push(ev);
    else masters.set(ev.uid || `no-uid-${i}`, ev);
  });
  for (const ex of exceptions) masters.get(ex.uid)?.relateException(ex);

  const items: Item[] = [];
  for (const ev of masters.values()) {
    if (isCancelled(ev) || !ev.startDate) continue;
    if (ev.isRecurring()) {
      const it = ev.iterator();
      for (let n = 0, t: IcalTime | undefined = it.next(); t && n < 5000; n++, t = it.next()) {
        const occ = ev.getOccurrenceDetails(t);
        const start = occ.startDate.toJSDate().getTime();
        if (start > now + EXPAND_FUTURE) break;
        const end = occ.endDate ? occ.endDate.toJSDate().getTime() : start;
        if (end < now - DAY || isCancelled(occ.item)) continue;
        items.push(toItem(occ.item, occ.startDate, occ.endDate, sourceId, kind, `@${start}`));
      }
    } else {
      const item = toItem(ev, ev.startDate, ev.endDate, sourceId, kind, "");
      if (item.start >= now - KEEP_PAST && item.start <= now + KEEP_FUTURE) items.push(item);
    }
  }

  const calName = root.getFirstPropertyValue("x-wr-calname");
  return {
    calName: typeof calName === "string" && calName.trim() ? calName.trim() : undefined,
    items: items.sort((a, b) => a.start - b.start),
  };
}

function toItem(
  ev: IcalEvent,
  startTime: IcalTime,
  endTime: IcalTime | null | undefined,
  sourceId: string,
  kind: SourceKind,
  suffix: string,
): Item {
  const summary = (ev.summary || "").trim() || "（无标题）";
  const url = textProp(ev, "url");
  const uid = ev.uid || `${summary}|${startTime.toString()}`;
  // Canvas marks assignments/quizzes with these UIDs and links.
  const deadline =
    kind === "canvas" &&
    (uid.startsWith("event-assignment") || /\/(assignments|quizzes|discussion_topics)\//.test(url ?? ""));

  // Canvas appends the course: "Problem Set 3 [ECON 101 - Fall 2026]".
  let title = summary;
  let course: string | undefined;
  const m = kind === "canvas" ? summary.match(/^(.*?)\s*\[([^\]]+)\]$/) : null;
  if (m && m[1]) {
    title = m[1];
    course = m[2].trim();
  }

  let start = startTime.toJSDate().getTime();
  // Assignments due at 11:59pm come through as all-day events.
  if (deadline && startTime.isDate) start += DAY - MIN;
  const end = !deadline && endTime ? endTime.toJSDate().getTime() : undefined;

  return {
    id: `${sourceId}:${uid}${suffix}`,
    sourceId,
    kind: deadline ? "deadline" : "event",
    title,
    course,
    courseShort: course ? shortCourse(course) : undefined,
    start,
    end,
    allDay: startTime.isDate && !deadline,
    location: ev.location?.trim() || undefined,
    url,
  };
}

function isCancelled(ev: IcalEvent): boolean {
  return String(ev.component.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED";
}

function textProp(ev: IcalEvent, name: string): string | undefined {
  const v = ev.component.getFirstPropertyValue(name);
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s || undefined;
}

/**
 * "ECON 101 - Fall 2026" → "ECON 101"; "CS61A: Structure…" → "CS 61A";
 * Stanford's "F26-MS&E-245A-01" (term-subject-number-section) → "MS&E 245A".
 */
export function shortCourse(course: string): string {
  const code = course.match(/(?:^|[^A-Za-z&])([A-Z][A-Z&]{1,7})[\s_-]?(\d{1,4}[A-Z]{0,2})(?![A-Za-z0-9])/);
  if (code) return `${code[1]} ${code[2]}`;
  const head = course.split(/\s[-–|:]\s/)[0].trim();
  return head.length > 16 ? `${head.slice(0, 15)}…` : head;
}

export function countKinds(items: Item[]): Counts {
  return {
    deadlines: items.filter((i) => i.kind === "deadline").length,
    events: items.filter((i) => i.kind === "event").length,
  };
}

/**
 * The same thing can arrive twice (the Canvas feed also subscribed in Google Calendar, where
 * titles keep their "[Course]" suffix; a Gradescope assignment also posted on Canvas). Same
 * title at the same minute → keep one: a deadline over an event, the Gradescope copy (it
 * knows whether you've submitted), then the copy that knows its course.
 */
export function dedupe(items: Item[]): Item[] {
  const rank = (i: Item) => (i.kind === "deadline" ? 4 : 0) + (i.submitted !== undefined ? 2 : 0) + (i.course ? 1 : 0);
  const norm = (t: string) => t.replace(/\s*\[[^\]]+\]$/, "").toLowerCase();
  const day = (ts: number) => new Date(ts).toDateString();
  // A Canvas "due 11:59pm" assignment shows up elsewhere as an all-day event that day.
  const deadlineDays = new Set(items.filter((i) => i.kind === "deadline").map((i) => `${norm(i.title)}|${day(i.start)}`));
  const byKey = new Map<string, Item>();
  for (const item of items) {
    const title = norm(item.title);
    if (item.kind === "event" && item.allDay && deadlineDays.has(`${title}|${day(item.start)}`)) continue;
    const key = `${title}|${Math.round(item.start / MIN)}`;
    const seen = byKey.get(key);
    if (!seen || rank(item) > rank(seen)) byKey.set(key, item);
  }
  return [...byKey.values()].sort((a, b) => a.start - b.start);
}
