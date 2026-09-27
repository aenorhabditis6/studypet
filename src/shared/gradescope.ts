// Gradescope has no student API, so this reads the user's own pages — fetched by Rust with
// the session from the built-in Gradescope window — and parses them. Selectors follow the
// student view (as used by the open-source gradescopeapi project); if Gradescope changes its
// markup this is the one place to update.
import { invoke, log } from "./bridge";
import { shortCourse } from "./ics";
import type { Item } from "./types";

export const GRADESCOPE = "https://www.gradescope.com";
export const GRADESCOPE_SOURCE = "gradescope";

const DAY = 86_400_000;

interface Page {
  url: string;
  status: number;
  html: string;
}

export interface GsCourse {
  id: string;
  name: string;
  fullName?: string;
  term?: string;
}

const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

/**
 * Student courses of the newest term on the dashboard, or null when the page isn't the
 * logged-in dashboard (i.e. the session expired).
 */
export function parseDashboard(html: string): GsCourse[] | null {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const account = doc.querySelector("#account-show");
  if (!account) return null;

  // Staff see "Instructor Courses" first and "Student Courses" after; students see no headings.
  let section = doc.querySelector("button.js-createNewCourse") ? "instructor" : "student";
  let term = "";
  let newestStudentTerm: string | null = null;
  const courses = new Map<string, GsCourse>();
  for (const el of account.querySelectorAll("h2.pageHeading, .courseList--term, a[href^='/courses/']")) {
    if (el.matches("h2.pageHeading")) {
      section = /student/i.test(text(el)) ? "student" : "instructor";
    } else if (el.matches(".courseList--term")) {
      term = text(el);
    } else if (section === "student") {
      const id = (el.getAttribute("href") ?? "").split("/")[2] ?? "";
      const shortname = el.querySelector(".courseBox--shortname");
      if (!/^\d+$/.test(id) || !shortname) continue;
      newestStudentTerm ??= term;
      if (term !== newestStudentTerm) continue;
      courses.set(id, {
        id,
        name: text(shortname),
        fullName: text(el.querySelector(".courseBox--name")) || undefined,
        term: term || undefined,
      });
    }
  }
  return [...courses.values()];
}

/** Assignments on a student course page. Null when it isn't one (e.g. logged out). */
export function parseCourse(html: string, course: GsCourse): Item[] | null {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const table = doc.querySelector("#assignments-student-table");
  let rows = [...doc.querySelectorAll("#assignments-student-table tbody tr")];
  if (!rows.length) {
    rows = [...doc.querySelectorAll("tr[role='row']")].filter(
      (r) => r.querySelector("th") && r.querySelectorAll("td").length >= 2,
    );
  }
  if (!table && !rows.length) return null;

  const items: Item[] = [];
  for (const row of rows) {
    const head = row.querySelector("th");
    if (!head) continue;
    const link = head.querySelector("a[href]");
    const button = head.querySelector("button[data-assignment-id]");
    const title = text(link ?? button ?? head);
    const href = link?.getAttribute("href") ?? "";
    const assignmentId = button?.getAttribute("data-assignment-id") ?? href.split("/")[4] ?? "";
    const dues = row.querySelectorAll(".submissionTimeChart--dueDate");
    const due = parseGsDate(dues[0]?.getAttribute("datetime"));
    if (!title || due === undefined) continue;
    // "No Submission" until something is uploaded; afterwards "Submitted" or a score.
    const status = text(row.querySelector("td"));
    items.push({
      id: `${GRADESCOPE_SOURCE}:${course.id}:${assignmentId || title}`,
      sourceId: GRADESCOPE_SOURCE,
      kind: "deadline",
      title,
      course: course.name,
      courseShort: shortCourse(course.name),
      start: due,
      allDay: false,
      // A submitted row links to the submission; otherwise the course page, whose row button opens the upload dialog.
      url: href.startsWith("/") ? `${GRADESCOPE}${href}` : `${GRADESCOPE}/courses/${course.id}`,
      submitted: status !== "" && !/no submission/i.test(status),
      lateDue: parseGsDate(dues[1]?.getAttribute("datetime")),
    });
  }
  return items;
}

/** "2026-10-05 23:00:00 -0700" (Gradescope's format; WebKit won't parse it as-is) → epoch ms. */
export function parseGsDate(value?: string | null): number | undefined {
  if (!value) return undefined;
  const m = value.trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?$/);
  let t: number;
  if (m) {
    const zone = !m[3] || m[3] === "Z" ? m[3] ?? "" : m[3].includes(":") ? m[3] : `${m[3].slice(0, 3)}:${m[3].slice(3)}`;
    t = Date.parse(`${m[1]}T${m[2]}${zone}`);
  } else {
    t = Date.parse(value);
  }
  return Number.isNaN(t) ? undefined : t;
}

/** Everything due in the current term's courses, or "logged-out" if the session is gone. */
export async function fetchGradescope(now = Date.now()): Promise<Item[] | "logged-out"> {
  const home = await invoke<Page>("gradescope_fetch", { path: "/" });
  const courses = parseDashboard(home.html);
  if (!courses) {
    log("gradescope: dashboard not available (logged out?)", home.status);
    return "logged-out";
  }
  const items: Item[] = [];
  for (const course of courses.slice(0, 12)) {
    const page = await invoke<Page>("gradescope_fetch", { path: `/courses/${course.id}` });
    const parsed = parseCourse(page.html, course);
    log(`gradescope: course ${course.id} → ${parsed === null ? "not a student course page" : `${parsed.length} assignments`}`);
    if (parsed) items.push(...parsed);
  }
  log(`gradescope: ${courses.length} courses, ${items.length} assignments`);
  // Past items only matter briefly (recently submitted / just missed).
  return items.filter((i) => i.start >= now - 14 * DAY && i.start <= now + 150 * DAY);
}

export function isGradescopeUrl(url?: string): boolean {
  return !!url && url.startsWith(`${GRADESCOPE}/`);
}
