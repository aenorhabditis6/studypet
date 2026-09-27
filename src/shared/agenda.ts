import type { DoneMap } from "./store";
import type { Item } from "./types";

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/**
 * How pressing things are right now. The pet shows this through its posture first
 * (calm → idle, soon → fidgeting, urgent → flustered) and only speaks at thresholds.
 */
export type Level = "empty" | "calm" | "heads-up" | "overdue" | "soon" | "urgent";

export interface Outlook {
  level: Level;
  /** The next open deadline, if any. */
  next?: Item;
  /** Open deadlines due within 24 hours. */
  within24h: Item[];
  /** Open deadlines that passed in the last 3 days. */
  overdue: Item[];
}

/** Deadlines still to do: not ticked off by hand, and not already submitted on Gradescope. */
export function openDeadlines(items: Item[], done: DoneMap): Item[] {
  return items.filter((i) => i.kind === "deadline" && !done[i.id] && !i.submitted).sort((a, b) => a.start - b.start);
}

export function outlook(items: Item[], done: DoneMap, now = Date.now()): Outlook {
  const open = openDeadlines(items, done);
  const upcoming = open.filter((i) => i.start >= now);
  const overdue = open.filter((i) => i.start < now && i.start >= now - 3 * DAY);
  const next = upcoming[0];
  const within24h = upcoming.filter((i) => i.start - now <= DAY);
  const wait = next ? next.start - now : Infinity;

  let level: Level;
  if (items.length === 0) level = "empty";
  else if (wait <= 3 * HOUR) level = "urgent";
  else if (wait <= DAY) level = "soon";
  else if (overdue.length) level = "overdue";
  else if (wait <= 2 * DAY) level = "heads-up";
  else level = "calm";
  return { level, next, within24h, overdue };
}

/** Timed calendar events (classes, sections, office hours) starting in [from, to). */
export function eventsBetween(items: Item[], from: number, to: number): Item[] {
  return items.filter((i) => i.kind === "event" && !i.allDay && i.start >= from && i.start < to);
}

/**
 * Office hours and similar drop-in sessions: listed in the agenda, but the pet doesn't
 * announce them — a course can have a dozen a week and nobody goes to all of them.
 */
export function isOptionalEvent(i: Item): boolean {
  return /office\s*hours?|\bOH\b|drop[\s-]?in|答疑/i.test(i.title);
}

/** Events worth a heads-up before they start (classes, sections, exams…). */
export function remindableEvents(items: Item[], from: number, to: number): Item[] {
  return eventsBetween(items, from, to).filter((i) => !isOptionalEvent(i));
}
