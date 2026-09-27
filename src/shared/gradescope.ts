// Gradescope has no student API, so this reads the user's own pages — fetched by Rust with
// the session from the built-in Gradescope window — and parses them. Selectors follow the
// student view (as used by the open-source gradescopeapi project); if Gradescope changes its
// markup this is the one place to update.
import { invoke, log } from "./bridge";
import { shortCourse } from "./ics";
import type { Item } from "./types";

export const GRADESCOPE_SOURCE = "gradescope";

/** Gradescope runs a separate site per region; a school uses one of them. */
export const GRADESCOPE_SITES: { host: string; label: string }[] = [
  { host: "www.gradescope.com", label: "gradescope.com（美国和大多数学校）" },
  { host: "www.gradescope.ca", label: "gradescope.ca（加拿大）" },
  { host: "www.gradescope.eu", label: "gradescope.eu（欧洲）" },
  { host: "www.gradescope.com.au", label: "gradescope.com.au（澳洲）" },
];
export const DEFAULT_GRADESCOPE_SITE = "www.gradescope.com";

export const gradescopeHome = (site = DEFAULT_GRADESCOPE_SITE) => `https://${site}/`;

/** The Gradescope site a link is on, if it's on one. */
export function gradescopeSiteOf(url?: string): string | null {
  try {
    const u = new URL(url ?? "");
    const host = u.hostname.startsWith("www.") ? u.hostname : `www.${u.hostname}`;
    return u.protocol === "https:" && GRADESCOPE_SITES.some((s) => s.host === host) ? host : null;
  } catch {
    return null;
  }
}

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
 *
 * The heading before each course list says whose courses they are ("Instructor Courses",
 * "Student Courses"). Lists without such a heading are the user's own: a student's dashboard
 * is just "Your Courses" — even when it offers a "Create Course" button — so only pages with
 * explicit staff sections need telling apart.
 */
export function parseDashboard(html: string): GsCourse[] | null {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const account = doc.querySelector("#account-show");
  if (!account) return null;

  const lists = [...account.querySelectorAll(".courseList")].filter((list) => !list.parentElement?.closest(".courseList"));
  const roles = lists.map((list) => {
    for (let el = list.previousElementSibling; el && !el.matches(".courseList"); el = el.previousElementSibling) {
      if (!el.matches("h1, h2, h3, .pageHeading")) continue;
      const heading = text(el);
      if (/instructor|teaching assistant|\bTAs?\b|staff/i.test(heading)) return "staff";
      if (/student/i.test(heading)) return "student";
    }
    return "unlabelled";
  });
  const hasStaffSection = roles.includes("staff");

  const courses = new Map<string, GsCourse>();
  let newestTerm: string | null = null;
  lists.forEach((list, k) => {
    if (roles[k] === "staff" || (roles[k] === "unlabelled" && hasStaffSection)) return;
    // Terms newest first; older ones may sit in a collapsed "inactive courses" part.
    let term = "";
    for (const el of list.querySelectorAll(".courseList--term, a[href*='/courses/']")) {
      if (el.matches(".courseList--term")) {
        term = text(el);
        continue;
      }
      const id = el.getAttribute("href")?.match(/\/courses\/(\d+)/)?.[1];
      const fullName = text(el.querySelector(".courseBox--name"));
      const name = text(el.querySelector(".courseBox--shortname")) || fullName;
      if (!id || !name) continue;
      newestTerm ??= term;
      if (term !== newestTerm || courses.has(id)) continue;
      courses.set(id, { id, name, fullName: fullName || undefined, term: term || undefined });
    }
  });
  return [...courses.values()];
}

/** Assignments on a student course page. Null when it isn't one (e.g. logged out). */
export function parseCourse(html: string, course: GsCourse, site = DEFAULT_GRADESCOPE_SITE): Item[] | null {
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
    const button = head.querySelector("button");
    const title = text(link ?? button ?? head);
    const href = link?.getAttribute("href") ?? "";
    const assignmentId =
      row.querySelector("[data-assignment-id]")?.getAttribute("data-assignment-id") ?? href.match(/\/assignments\/(\d+)/)?.[1] ?? "";
    // Due date, then the late due date if there is one (release dates aren't due dates).
    let dues = [...row.querySelectorAll(".submissionTimeChart--dueDate")];
    if (!dues.length) dues = [...row.querySelectorAll("time[datetime]")].filter((t) => !/release/i.test(t.className));
    const dateOf = (el?: Element) => parseGsDate(el?.getAttribute("datetime") ?? el?.querySelector("time[datetime]")?.getAttribute("datetime"));
    const due = dateOf(dues[0]);
    if (!title || due === undefined) continue;
    // "No Submission" until something is uploaded; afterwards "Submitted" or a score.
    const status = text(row.querySelector(".submissionStatus--text") ?? row.querySelector("td"));
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
      url: href.startsWith("/") ? `https://${site}${href}` : `https://${site}/courses/${course.id}`,
      submitted: status !== "" && !/no submission/i.test(status),
      lateDue: dateOf(dues[1]),
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
export async function fetchGradescope(site: string, now = Date.now()): Promise<Item[] | "logged-out"> {
  const home = await invoke<Page>("gradescope_fetch", { site, path: "/" });
  const courses = parseDashboard(home.html);
  if (!courses) {
    log("gradescope: dashboard not available (logged out?)", home.status);
    return "logged-out";
  }
  const items: Item[] = [];
  for (const course of courses.slice(0, 12)) {
    const page = await invoke<Page>("gradescope_fetch", { site, path: `/courses/${course.id}` });
    const parsed = parseCourse(page.html, course, site);
    log(`gradescope: course ${course.id} → ${parsed === null ? "not a student course page" : `${parsed.length} assignments`}`);
    if (parsed) items.push(...parsed);
  }
  log(`gradescope: ${courses.length} courses, ${items.length} assignments`);
  // Past items only matter briefly (recently submitted / just missed).
  return items.filter((i) => i.start >= now - 14 * DAY && i.start <= now + 150 * DAY);
}

export function isGradescopeUrl(url?: string): boolean {
  return gradescopeSiteOf(url) !== null;
}
