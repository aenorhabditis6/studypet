// Sanity checks for the .ics parser and urgency logic against the sample Canvas feed.
// Run: node scripts/check-ics.ts   (Node ≥ 23 runs TypeScript directly)
import assert from "node:assert/strict";
import { isOptionalEvent, outlook, remindableEvents } from "../src/shared/agenda.ts";
import { meetingName, relative, splitLocation } from "../src/shared/format.ts";
import { dedupe, parseIcs, shortCourse } from "../src/shared/ics.ts";
import { addSpan, focusText, focusedToday } from "../src/shared/focus.ts";
import { sampleCanvasIcs } from "../src/dev/sample-ics.ts";

const H = 3_600_000;
const D = 24 * H;
const now = Date.now();
const { items, calName } = parseIcs(sampleCanvasIcs(now), "src", "canvas", now);
const fmt = (ts: number) => new Date(ts).toLocaleString("zh-CN", { hour12: false });

for (const i of items) {
  console.log(`${i.kind.padEnd(8)} ${fmt(i.start).padEnd(20)} ${i.title} | ${i.courseShort ?? "-"} | ${i.location ?? ""}`);
}

assert.equal(calName, "Alex Chen Calendar (Canvas)");
const deadlines = items.filter((i) => i.kind === "deadline");
assert.equal(deadlines.length, 7, "seven assignments/quizzes");
assert.equal(deadlines.find((d) => d.title === "HW 1")?.courseShort, "MS&E 245A");
assert.ok(deadlines.every((d) => !d.title.includes("[")), "course suffix stripped from titles");
assert.equal(deadlines.find((d) => d.title === "Problem Set 3")?.courseShort, "ECON 101");

// All-day assignment → due 23:59 local that day.
const proposal = deadlines.find((d) => d.title === "Project Proposal")!;
const due = new Date(proposal.start);
assert.deepEqual([due.getHours(), due.getMinutes()], [23, 59], "all-day assignment due at 23:59");
assert.equal(proposal.allDay, false);

// Quiz detected through its URL.
assert.ok(deadlines.some((d) => d.title === "Midterm Review Quiz"));

// Weekly lecture: expanded, only upcoming within 21 days, next one moved online.
const lectures = items.filter((i) => i.title === "CS 61C Lecture");
assert.ok(lectures.length >= 2 && lectures.length <= 4, `lectures expanded (${lectures.length})`);
assert.ok(lectures.every((l) => l.start <= now + 21 * D && (l.end ?? l.start) >= now - D));
const nextLecture = lectures.find((l) => l.start >= now)!;
assert.equal(nextLecture.location, "Online (Zoom)", "RECURRENCE-ID override applied");
assert.equal(nextLecture.end! - nextLecture.start, 80 * 60_000, "80-minute lecture");
assert.equal(new Set(lectures.map((l) => l.id)).size, lectures.length, "occurrence ids unique");

// Urgency: Problem Set 3 is due in ~2h → urgent; marking it done → soon (Reading Response in 20h).
const o = outlook(items, {}, now);
assert.equal(o.level, "urgent");
assert.equal(o.next?.title, "Problem Set 3");
assert.equal(o.overdue.length, 1);
const ps3 = deadlines.find((d) => d.title === "Problem Set 3")!;
assert.equal(outlook(items, { [ps3.id]: now }, now).level, "soon");
const allDone = Object.fromEntries(deadlines.filter((d) => d.start >= now - 3 * D).map((d) => [d.id, now]));
assert.equal(outlook(items, allDone, now).level, "calm");
assert.equal(outlook([], {}, now).level, "empty");
// Only the overdue one left open → overdue (gentle "can you still submit?")
const onlyOverdue = Object.fromEntries(deadlines.filter((d) => d.start >= now).map((d) => [d.id, now]));
assert.equal(outlook(items, onlyOverdue, now).level, "overdue");

// Dedupe: the same feed subscribed twice collapses to one copy.
const twice = dedupe([...items, ...parseIcs(sampleCanvasIcs(now), "other", "calendar", now).items]);
assert.equal(twice.length, items.length, "duplicates removed");
assert.ok(twice.filter((i) => i.kind === "deadline").every((i) => i.sourceId === "src"), "Canvas copy preferred");

assert.equal(shortCourse("ECON 101 - Fall 2026"), "ECON 101");
assert.equal(shortCourse("CS61A: Structure and Interpretation"), "CS 61A");
assert.equal(shortCourse("F26-MS&E-245A-01"), "MS&E 245A");
assert.equal(shortCourse("F26-MS&E-319-01"), "MS&E 319");
assert.equal(shortCourse("F26-CS-229-01"), "CS 229");
// Other schools' formats.
assert.equal(shortCourse("COMP1234 Algorithms"), "COMP 1234");
assert.equal(shortCourse("MATH-2210-001 Calculus III"), "MATH 2210");
assert.equal(shortCourse("15-213 Intro to Computer Systems"), "15-213");

// Time left always rounds down ("后天 23:59" must not read "还有 3 天" with 2.9 days left).
assert.equal(relative(now + 2.9 * D, now), "还有 2 天");
assert.equal(relative(now + 20.9 * H, now), "还有 20 小时");
assert.equal(relative(now + 2 * H + 40 * 60_000 + 30_000, now), "还有 2 小时 40 分钟");
assert.equal(relative(now + 30_000, now), "还有 1 分钟");
assert.equal(relative(now - 5.5 * H, now), "已经过了 5 小时");

// Meeting links become a button; the password line that repeats the link is dropped.
assert.deepEqual(splitLocation("https://school.zoom.us/j/1?pwd=x Password: 000000"), { url: "https://school.zoom.us/j/1?pwd=x", text: undefined });
assert.deepEqual(splitLocation("Zoom: https://school.zoom.us/j/1"), { url: "https://school.zoom.us/j/1", text: undefined });
assert.deepEqual(splitLocation("CODA E46"), { text: "CODA E46" });
assert.equal(meetingName("https://school.zoom.us/j/1"), "Zoom");

// Office hours are listed but never announced.
const oh = items.find((i) => i.title === "Rose's Office Hour")!;
assert.ok(isOptionalEvent(oh));
for (const t of ["Instructor OH", "Senem’s Zoom OH", "Office Hours"]) assert.ok(isOptionalEvent({ ...oh, title: t }), t);
assert.ok(!isOptionalEvent(nextLecture));
assert.ok(!remindableEvents(items, now, now + 60 * D).some(isOptionalEvent));
assert.ok(remindableEvents(items, now, now + 60 * D).some((i) => i.title === "CS 61C Lecture"));
assert.equal(shortCourse("Linguistics"), "Linguistics");
assert.equal(shortCourse("Introduction to Psychology"), "Introduction to…", "long names are truncated for the chip");


// Focused today: pomodoros and focus mode, overlaps once, breaks and yesterday not at all.
{
  const noon = new Date();
  noon.setHours(12, 0, 0, 0);
  const t = noon.getTime();
  const M = 60_000;
  const log = [
    { start: t - 13 * 60 * M, end: t - 11 * 60 * M }, // 23:00 yesterday → 01:00: only the hour after midnight
    { start: t - 60 * M, end: t - 35 * M }, // a 25-minute pomodoro
    { start: t - 40 * M, end: t - 20 * M }, // focus mode overlapping it by 5 minutes
  ];
  assert.equal(focusedToday(log, null, t), (60 + 25 + 15) * M);
  const pomodoro = { kind: "pomodoro" as const, startedAt: t - 10 * M, endsAt: t + 15 * M, lock: false };
  assert.equal(focusedToday(log, pomodoro, t), (60 + 25 + 15 + 10) * M, "the running pomodoro so far");
  const rest = { kind: "break" as const, startedAt: t - 10 * M, endsAt: t + 5 * M, lock: false };
  assert.equal(focusedToday(log, rest, t), (60 + 25 + 15) * M, "breaks don't count");
  assert.equal(focusedToday([], null, t), 0);
  assert.equal(addSpan([{ start: t - 20 * 86_400_000, end: t - 20 * 86_400_000 + M }], { start: t - M, end: t }, t).length, 1, "old spans are dropped");
  assert.equal(focusText(0), "0 分钟");
  assert.equal(focusText(83 * M), "1 小时 23 分钟");
  assert.equal(focusText(120 * M), "2 小时");
}

console.log(`\nall checks passed (${items.length} items, tz ${Intl.DateTimeFormat().resolvedOptions().timeZone})`);
