// A Canvas-style calendar feed with times relative to `now`, for the design preview and the
// self test. Covers: timed and all-day assignments, a quiz, an overdue item, a one-off
// calendar event, and a weekly class in a named time zone with one moved occurrence.
// (Only erasable TypeScript here so Node can import this file directly.)

const H = 3_600_000;
const D = 24 * H;
const TZ = "America/Los_Angeles";

const pad = (n: number) => String(n).padStart(2, "0");

function utc(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;
}

function localDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

/** Wall-clock time in TZ, formatted for DTSTART;TZID=… */
function zoned(ts: number): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(new Date(ts))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}${parts.month}${parts.day}T${parts.hour}${parts.minute}00`;
}

const VTIMEZONE = [
  "BEGIN:VTIMEZONE",
  `TZID:${TZ}`,
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:-0800",
  "TZOFFSETTO:-0700",
  "TZNAME:PDT",
  "DTSTART:19700308T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:-0700",
  "TZOFFSETTO:-0800",
  "TZNAME:PST",
  "DTSTART:19701101T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
];

export function sampleCanvasIcs(now: number = Date.now()): string {
  const out: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:icalendar-ruby",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Alex Chen Calendar (Canvas)",
    ...VTIMEZONE,
  ];
  const stamp = `DTSTAMP:${utc(now)}`;
  const assignment = (id: number, title: string, course: string, due: number, kind = "assignments") =>
    out.push(
      "BEGIN:VEVENT",
      `DTSTART:${utc(due)}`,
      `DTEND:${utc(due)}`,
      stamp,
      `SUMMARY:${title} [${course}]`,
      `UID:event-assignment-${id}`,
      `URL;VALUE=URI:https://canvas.example.edu/courses/4821/${kind}/${id}`,
      "END:VEVENT",
    );

  assignment(9001, "Problem Set 3", "ECON 101 - Fall 2026", now + 2 * H + 10 * 60_000);
  assignment(9002, "Reading Response 4", "ENGL 150 - Fall 2026", now + 20 * H);
  assignment(9003, "Lab 2: Pointers", "CS 61C - Fall 2026", now + 2 * D + 3 * H);
  assignment(9004, "Midterm Review Quiz", "MATH 54 - Fall 2026", now + 5 * D, "quizzes");
  assignment(9005, "Discussion Post: Memory", "PSYCH 1 - Fall 2026", now - 5 * H);
  // Stanford-style course code, due beyond this week.
  assignment(9007, "HW 1", "F26-MS&E-245A-01", now + 12 * D);
  // "Due 11:59pm" assignments arrive as all-day events.
  out.push(
    "BEGIN:VEVENT",
    `DTSTART;VALUE=DATE:${localDate(now + 3 * D)}`,
    `DTEND;VALUE=DATE:${localDate(now + 4 * D)}`,
    stamp,
    "SUMMARY:Project Proposal [DATA 100 - Fall 2026]",
    "UID:event-assignment-9006",
    "URL;VALUE=URI:https://canvas.example.edu/courses/4821/assignments/9006",
    "END:VEVENT",
  );
  out.push(
    "BEGIN:VEVENT",
    `DTSTART:${utc(now + 26 * H)}`,
    `DTEND:${utc(now + 27 * H)}`,
    stamp,
    "SUMMARY:Office Hours [ECON 101 - Fall 2026]",
    "UID:event-calendar-event-551",
    "LOCATION:Evans Hall 608",
    "END:VEVENT",
    // Online office hours: the location is a meeting link plus its password.
    "BEGIN:VEVENT",
    `DTSTART:${utc(now + 30 * H)}`,
    `DTEND:${utc(now + 32 * H)}`,
    stamp,
    "SUMMARY:Rose's Office Hour [F26-MS&E-245A-01]",
    "UID:event-calendar-event-552",
    "LOCATION:https://school.zoom.us/j/123456789?pwd=abcDEF Password: 000000",
    "END:VEVENT",
  );

  // Weekly lecture that started three weeks ago, 80 minutes long.
  const first = Math.floor((now - 21 * D + 30 * 60_000) / H) * H;
  const firstUpcoming = first + Math.ceil((now - first) / (7 * D)) * 7 * D;
  out.push(
    "BEGIN:VEVENT",
    `DTSTART;TZID=${TZ}:${zoned(first)}`,
    `DTEND;TZID=${TZ}:${zoned(first + 80 * 60_000)}`,
    stamp,
    "RRULE:FREQ=WEEKLY;COUNT=15",
    "SUMMARY:CS 61C Lecture [CS 61C - Fall 2026]",
    "UID:event-calendar-event-700",
    "LOCATION:Wheeler Auditorium",
    "END:VEVENT",
    // The next lecture moved online.
    "BEGIN:VEVENT",
    `RECURRENCE-ID;TZID=${TZ}:${zoned(firstUpcoming)}`,
    `DTSTART;TZID=${TZ}:${zoned(firstUpcoming)}`,
    `DTEND;TZID=${TZ}:${zoned(firstUpcoming + 80 * 60_000)}`,
    stamp,
    "SUMMARY:CS 61C Lecture [CS 61C - Fall 2026]",
    "UID:event-calendar-event-700",
    "LOCATION:Online (Zoom)",
    "END:VEVENT",
  );
  out.push("END:VCALENDAR");
  return out.join("\r\n") + "\r\n";
}
