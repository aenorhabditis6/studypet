// How long you've focused today: pomodoros and focus mode, breaks not included. Stretches
// are kept as time spans and merged before adding up, so time covered twice counts once.
import type { FocusSpan, Session } from "./types";

const DAY = 86_400_000;

/** Adds a finished stretch to the log, forgetting ones older than two weeks. */
export function addSpan(log: FocusSpan[], span: FocusSpan, now = Date.now()): FocusSpan[] {
  const kept = log.filter((s) => s.end > now - 14 * DAY);
  return span.end > span.start ? [...kept, span] : kept;
}

/** Milliseconds focused since midnight, counting the session running now (if it's focus time). */
export function focusedToday(log: FocusSpan[], running: Session | null, now = Date.now()): number {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const spans = [...log];
  if (running && running.kind !== "break") spans.push({ start: running.startedAt, end: Math.min(now, running.endsAt ?? now) });
  const today = spans
    .map((s) => ({ start: Math.max(s.start, midnight.getTime()), end: Math.min(s.end, now) }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);
  let total = 0;
  let from = 0;
  let to = 0;
  for (const s of today) {
    if (s.start > to) {
      total += to - from;
      from = s.start;
      to = s.end;
    } else {
      to = Math.max(to, s.end);
    }
  }
  return total + (to - from);
}

/** "1 小时 23 分钟", "23 分钟". */
export function focusText(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} 分钟`;
  return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
}
