// Ed Discussion, through its (beta, unofficial) API with a personal token. Only
// announcements surface as pet notices; other threads just feed a per-course unread count.
import { invoke, log } from "./bridge";
import { shortCourse } from "./ics";
import type { EdCourse, Notice } from "./types";

export const ED_SOURCE = "ed";
export const ED_TOKEN_PAGE = "https://edstem.org/us/settings/api-tokens";

const DAY = 86_400_000;
const THREADS_PER_COURSE = 30;

export interface EdUserResponse {
  user: { name: string };
  courses: { course: { id: number; code: string; name: string; status: string } }[];
}

export interface EdThread {
  id: number;
  course_id: number;
  type: string;
  title: string;
  created_at: string;
  is_seen: boolean;
}

export function activeCourses(user: EdUserResponse): EdUserResponse["courses"][number]["course"][] {
  return user.courses.map((c) => c.course).filter((c) => c.status === "active");
}

export function threadUrl(courseId: number, threadId: number): string {
  return `https://edstem.org/us/courses/${courseId}/discussion/${threadId}`;
}

/** Announcements from the last three weeks, newest first. */
export function toNotices(threads: EdThread[], course: { id: number; code: string }, now = Date.now()): Notice[] {
  return threads
    .filter((t) => t.type === "announcement")
    .map((t) => ({
      id: `${ED_SOURCE}:${t.id}`,
      courseId: course.id,
      course: shortCourse(course.code),
      title: t.title.trim() || "（无标题）",
      url: threadUrl(course.id, t.id),
      createdAt: Date.parse(t.created_at),
      seen: t.is_seen,
    }))
    .filter((n) => !Number.isNaN(n.createdAt) && n.createdAt >= now - 21 * DAY)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function fetchEd(now = Date.now()): Promise<{ user: EdUserResponse; notices: Notice[]; courses: EdCourse[] }> {
  const user = JSON.parse(await invoke<string>("ed_user")) as EdUserResponse;
  const notices: Notice[] = [];
  const courses: EdCourse[] = [];
  for (const c of activeCourses(user).slice(0, 12)) {
    const { threads } = JSON.parse(await invoke<string>("ed_threads", { courseId: c.id, limit: THREADS_PER_COURSE })) as {
      threads: EdThread[];
    };
    notices.push(...toNotices(threads, c, now));
    courses.push({ id: c.id, code: shortCourse(c.code), name: c.name, unseen: threads.filter((t) => !t.is_seen).length });
  }
  log(`ed: ${courses.length} courses, ${notices.length} announcements`);
  notices.sort((a, b) => b.createdAt - a.createdAt);
  return { user, notices, courses };
}
