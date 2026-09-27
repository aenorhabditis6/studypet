export interface PetInfo {
  /** "codex-atlas": a Codex pet spritesheet; "image": one picture the app animates itself. */
  kind: "codex-atlas" | "image";
  name: string;
  description?: string | null;
  imageFile: string;
  mime: string;
  spriteVersion?: number | null;
  origin: "default" | "codex" | "upload";
  /** Pictures only: "cutout" (background removed, animated eyes) or "original" (as is). */
  mode?: PictureMode;
}

export type PictureMode = "cutout" | "original";

/** A pet installed for the Codex app, offered during onboarding. */
export interface CodexPetRef {
  id: string;
  name: string;
  path: string;
}

/** Calendar feeds (.ics), plus Gradescope (read through the built-in window's login) and Ed. */
export type SourceKind = "canvas" | "calendar" | "gradescope" | "ed";

/** A connected source. Secrets (feed URL, Ed token) live in the OS keychain, never here. */
/** Ed runs a server per region; a school's Ed address shows which (edstem.org/us/…). */
export type EdRegion = "us" | "eu" | "au";

export interface Source {
  id: string;
  name: string;
  kind: SourceKind;
  addedAt: number;
  lastSync?: number;
  lastError?: string | null;
  counts?: Counts;
  /** Gradescope: the school's Gradescope site ("www.gradescope.ca"). */
  site?: string;
  /** Ed: the school's Ed region. */
  region?: EdRegion;
}

export interface Counts {
  deadlines: number;
  events: number;
  /** Ed announcements. */
  notices?: number;
}

/** A Canvas due date ("deadline") or a calendar event such as a class ("event"). */
export interface Item {
  id: string;
  sourceId: string;
  kind: "deadline" | "event";
  title: string;
  course?: string;
  courseShort?: string;
  /** Due time for deadlines, start time for events (epoch ms). */
  start: number;
  end?: number;
  allDay: boolean;
  location?: string;
  url?: string;
  /** Known only for Gradescope: whether the user has already submitted. */
  submitted?: boolean;
  /** Gradescope's late-submission deadline, if the course allows one. */
  lateDue?: number;
}

/** An Ed announcement. */
export interface Notice {
  id: string;
  courseId: number;
  course: string;
  title: string;
  url: string;
  createdAt: number;
  /** Whether the user has opened it on Ed. */
  seen: boolean;
}

/** Per-course Ed summary: how many of the newest threads the user hasn't opened. */
export interface EdCourse {
  id: number;
  code: string;
  name: string;
  unseen: number;
}

export interface Settings {
  /** Minutes before a class to remind (campuses can be big: default an hour). */
  classLeadMin: number;
  /** Pet height on the desktop, in CSS px. */
  petSize: number;
  /** What the pet says when clicked a third time and beyond; empty → the built-in list. */
  quips?: string[];
  /** Drink water / move / rest eyes every N minutes while you're at the computer. */
  health: { enabled: boolean; everyMin: number };
  pomodoro: { focusMin: number; breakMin: number; lockApps: boolean };
  /** Apps (bundle ids) that focus mode hides whenever they come to the front. */
  focusApps: string[];
  /** Shortcuts (Shortcuts app) that switch macOS Do Not Disturb on / off. */
  dndOn?: string;
  dndOff?: string;
}

export const WECHAT = "com.tencent.xinWeChat";

export const DEFAULT_SETTINGS: Settings = {
  classLeadMin: 60,
  petSize: 120,
  health: { enabled: true, everyMin: 45 },
  pomodoro: { focusMin: 25, breakMin: 5, lockApps: true },
  focusApps: [WECHAT],
};

/** A pomodoro, its break, or open-ended focus mode. */
/** A finished stretch of focus time (a pomodoro or focus mode). */
export interface FocusSpan {
  start: number;
  end: number;
}

export interface Session {
  kind: "pomodoro" | "break" | "focus";
  startedAt: number;
  endsAt?: number;
  /** Whether focus-mode app locking is on for this session. */
  lock: boolean;
}
