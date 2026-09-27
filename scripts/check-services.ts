// Checks for the Gradescope page parser and the Ed announcement conversion.
// Run: node --import ./scripts/ts-resolve.mjs scripts/check-services.ts
import assert from "node:assert/strict";
import { DOMParser } from "linkedom";
import { sampleEdThreads, sampleEdUser, sampleGradescopeCourse, sampleGradescopeDashboard } from "../src/dev/sample-services.ts";

// The parsers run in the webview; give Node the two browser globals they touch.
Object.assign(globalThis, { window: globalThis, DOMParser });
const { gradescopeSiteOf, isGradescopeUrl, parseCourse, parseDashboard, parseGsDate } = await import("../src/shared/gradescope.ts");
const { activeCourses, toNotices } = await import("../src/shared/ed.ts");
const { openDeadlines } = await import("../src/shared/agenda.ts");
const { dedupe } = await import("../src/shared/ics.ts");

const H = 3_600_000;
const D = 24 * H;
const now = Math.floor(Date.now() / 1000) * 1000; // Gradescope dates have whole seconds

// Dashboard: only the newest term's student courses.
const courses = parseDashboard(sampleGradescopeDashboard())!;
assert.deepEqual(
  courses.map((c) => [c.id, c.name, c.term]),
  [
    ["900001", "MS&E 245A", "Fall 2026"],
    ["900002", "CS 229", "Fall 2026"],
  ],
);
assert.equal(parseDashboard("<html><body><h1>Gradescope</h1><a href='/login'>Log In</a></body></html>"), null, "logged out");

// Staff who also take classes: instructor courses are skipped.
const mixed = `<div id="account-show"><button class="js-createNewCourse">Create</button>
  <h2 class="pageHeading">Instructor Courses</h2>
  <div class="courseList"><div class="courseList--term">Fall 2026</div>
    <a href="/courses/111"><h3 class="courseBox--shortname">CS 106A</h3></a></div>
  <h2 class="pageHeading">Student Courses</h2>
  <div class="courseList"><div class="courseList--term">Fall 2026</div>
    <a href="/courses/222"><h3 class="courseBox--shortname">MATH 51</h3></a></div></div>`;
assert.deepEqual(parseDashboard(mixed)!.map((c) => c.id), ["222"]);

// Course page.
const items = parseCourse(sampleGradescopeCourse("900001", now), courses[0])!;
assert.equal(items.length, 3);
const [ps1, ps2, report] = items;
assert.equal(ps1.title, "Problem Set 1");
assert.equal(ps1.submitted, true, "a score means submitted");
assert.equal(ps1.url, "https://www.gradescope.com/courses/900001/assignments/51900001/submissions/777");
assert.equal(ps1.id, "gradescope:900001:51900001");
assert.equal(ps2.submitted, false);
assert.equal(ps2.start, now + 30 * H);
assert.equal(ps2.lateDue, now + 54 * H);
assert.equal(ps2.url, "https://www.gradescope.com/courses/900001", "unsubmitted → course page with the upload button");
assert.equal(ps2.id, "gradescope:900001:52900001");
assert.equal(ps2.courseShort, "MS&E 245A");
assert.equal(report.id, "gradescope:900001:Final Project Report", "no id yet → title");
assert.equal(parseCourse("<html><body>Log in</body></html>", courses[0]), null);

// Schools on Gradescope's regional sites get links to their own site.
const [ca] = parseCourse(sampleGradescopeCourse("900001", now), courses[0], "www.gradescope.ca")!;
assert.equal(ca.url, "https://www.gradescope.ca/courses/900001/assignments/51900001/submissions/777");
assert.equal(gradescopeSiteOf("https://gradescope.com.au/courses/1"), "www.gradescope.com.au");
assert.equal(gradescopeSiteOf("https://www.gradescope.eu/"), "www.gradescope.eu");
assert.equal(gradescopeSiteOf("https://www.gradescope.com.evil.com/"), null);
assert.equal(gradescopeSiteOf("http://www.gradescope.com/"), null);
assert.equal(isGradescopeUrl("https://canvas.example.edu/x"), false);

// Submitted work isn't "to do".
assert.deepEqual(openDeadlines(items, {}).map((i) => i.title), ["Problem Set 2", "Final Project Report"]);

// The Gradescope copy wins over the same assignment from Canvas (it knows submission status).
const fromCanvas = { ...ps2, id: "canvas:1", sourceId: "canvas", submitted: undefined, url: "https://canvas.example.edu/x" };
const merged = dedupe([fromCanvas, ps2]);
assert.equal(merged.length, 1);
assert.equal(merged[0].sourceId, "gradescope");

// Gradescope's date format.
assert.equal(parseGsDate("2026-10-05 23:00:00 -0700"), Date.parse("2026-10-06T06:00:00Z"));
assert.equal(parseGsDate("2026-10-05T23:00:00Z"), Date.parse("2026-10-05T23:00:00Z"));
assert.equal(parseGsDate("2026-10-05 23:00:00 +0530"), Date.parse("2026-10-05T17:30:00Z"));
assert.equal(parseGsDate("not a date"), undefined);
assert.equal(parseGsDate(null), undefined);

// Ed: active courses only; announcements from the last three weeks, newest first.
const user = JSON.parse(sampleEdUser());
const active = activeCourses(user);
assert.deepEqual(active.map((c) => c.id), [71001, 71002]);
const notices = toNotices(JSON.parse(sampleEdThreads(71001, now)).threads, active[0], now);
assert.deepEqual(notices.map((n) => [n.title, n.seen]), [
  ["PS2 deadline moved to Wednesday", false],
  ["Welcome to MS&E 245A!", true],
]);
assert.equal(notices[0].url, "https://edstem.org/us/courses/71001/discussion/3001");
assert.equal(notices[0].course, "MS&E 245A");
const [au] = toNotices(JSON.parse(sampleEdThreads(71001, now)).threads, active[0], now, "au");
assert.equal(au.url, "https://edstem.org/au/courses/71001/discussion/3001", "links go to the school's Ed region");

console.log(`all service checks passed (${courses.length} courses, ${items.length} assignments, ${notices.length} notices)`);
