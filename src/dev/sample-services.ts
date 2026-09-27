// Stand-ins for Gradescope pages and Ed API responses, shaped like the real ones the parsers
// read. Used by the browser preview and scripts/check-services.ts.
// (Only erasable TypeScript here so Node can import this file directly.)

const H = 3_600_000;
const D = 24 * H;

/** Gradescope's datetime attribute format, in UTC: "2026-10-05 23:00:00 +0000". */
function gsDate(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").replace(/\.\d+Z$/, " +0000");
}

export function sampleGradescopeDashboard(): string {
  return `<!doctype html><html><head><title>Your Courses | Gradescope</title></head><body>
<div id="account-show">
  <h1 class="pageHeading">Your Courses</h1>
  <button class="tiiBtn js-createNewCourse" type="button">Create Course</button>
  <div class="courseList">
    <div class="courseList--term pageSubheading">Fall 2026</div>
    <div class="courseList--coursesForTerm">
      <a class="courseBox" href="/courses/900001">
        <h3 class="courseBox--shortname">MS&amp;E 245A</h3>
        <div class="courseBox--name">Investment Science</div>
        <div class="courseBox--assignments">3 assignments</div>
      </a>
      <a class="courseBox" href="/courses/900002">
        <h3 class="courseBox--shortname">CS 229</h3>
        <div class="courseBox--name">Machine Learning</div>
        <div class="courseBox--assignments">2 assignments</div>
      </a>
      <button class="courseBox courseBox-new">Add a course</button>
    </div>
    <div class="courseList--inactiveCourses">
      <div class="courseList--term pageSubheading">Spring 2026</div>
      <div class="courseList--coursesForTerm">
        <a class="courseBox" href="/courses/800001">
          <h3 class="courseBox--shortname">CS 161</h3>
          <div class="courseBox--name">Algorithms</div>
        </a>
      </div>
    </div>
  </div>
</div></body></html>`;
}

/** A student course page: one graded, one submittable (with a late deadline), one not yet open. */
export function sampleGradescopeCourse(courseId: string, now: number = Date.now()): string {
  const row = (head: string, status: string, due: number, lateDue?: number) => `
      <tr role="row">
        <th class="table--primaryLink" role="rowheader" scope="row">${head}</th>
        <td class="submissionStatus"><div class="submissionStatus--text">${status}</div></td>
        <td class="hidden-column">
          <div class="submissionTimeChart">
            <time class="submissionTimeChart--releaseDate" datetime="${gsDate(now - 7 * D)}">Released</time>
            <time class="submissionTimeChart--dueDate" datetime="${gsDate(due)}">Due</time>
            ${lateDue ? `<time class="submissionTimeChart--dueDate" datetime="${gsDate(lateDue)}">Late Due</time>` : ""}
          </div>
        </td>
      </tr>`;
  const prefix = courseId === "900002" ? "CS229 " : "";
  return `<!doctype html><html><body>
<table id="assignments-student-table" class="table">
  <thead><tr role="row"><th scope="col">Name</th><th scope="col">Status</th><th scope="col">Released / Due</th></tr></thead>
  <tbody>
    ${row(`<a href="/courses/${courseId}/assignments/51${courseId}/submissions/777">${prefix}Problem Set 1</a>`, "8.5 / 10.0", now - 2 * D)}
    ${row(`<button class="js-submitAssignment" data-assignment-id="52${courseId}" data-post-url="/courses/${courseId}/assignments/52${courseId}/submissions">${prefix}Problem Set 2</button>`, "No Submission", now + 30 * H, now + 54 * H)}
    ${row(`${prefix}Final Project Report`, "No Submission", now + 20 * D)}
  </tbody>
</table></body></html>`;
}

export function sampleEdUser(): string {
  return JSON.stringify({
    user: { name: "Alex Chen" },
    courses: [
      { course: { id: 71001, code: "MS&E 245A", name: "Investment Science", status: "active" } },
      { course: { id: 71002, code: "CS 229", name: "Machine Learning", status: "active" } },
      { course: { id: 60001, code: "CS 161", name: "Algorithms", status: "archived" } },
    ],
  });
}

export function sampleEdThreads(courseId: number, now: number = Date.now()): string {
  const t = (id: number, type: string, title: string, agoH: number, seen: boolean) => ({
    id,
    course_id: courseId,
    type,
    title,
    created_at: new Date(now - agoH * H).toISOString(),
    is_seen: seen,
  });
  const threads =
    courseId === 71001
      ? [
          t(3001, "announcement", "PS2 deadline moved to Wednesday", 3, false),
          t(3002, "question", "Question about Strategy 1 data", 5, false),
          t(3003, "announcement", "Welcome to MS&E 245A!", 24 * 6, true),
          t(3004, "announcement", "Old syllabus note", 24 * 40, true),
        ]
      : [t(4001, "post", "Study group for PS2?", 8, false), t(4002, "announcement", "Section times posted", 30, true)];
  return JSON.stringify({ sort_key: "", threads, users: [] });
}
