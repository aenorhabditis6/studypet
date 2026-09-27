import { emit, errorText, invoke, log } from "./bridge";
import { ED_SOURCE, fetchEd, type EdUserResponse } from "./ed";
import { DEFAULT_GRADESCOPE_SITE, fetchGradescope, GRADESCOPE_SOURCE } from "./gradescope";
import { countKinds, dedupe, parseIcs } from "./ics";
import { getItems, getSources, keys, store } from "./store";
import type { Counts, EdCourse, EdRegion, Item, Notice, Source, SourceKind } from "./types";

let running: Promise<SyncResult> | null = null;

export interface SyncResult {
  ok: number;
  failed: number;
  items: number;
}

const GRADESCOPE_LOGGED_OUT = "Gradescope 的登录过期了，打开 Gradescope 重新登录一下就好";

/** Re-reads every source. A source that fails keeps its previous data. */
export function syncAll(): Promise<SyncResult> {
  running ??= doSync().finally(() => {
    running = null;
  });
  return running;
}

async function doSync(): Promise<SyncResult> {
  const kv = await store();
  const sources = await getSources();
  const previous = await getItems();
  const next: Item[] = [];
  let ok = 0;
  let failed = 0;
  for (const s of sources) {
    try {
      if (s.kind === "gradescope") {
        const items = await fetchGradescope(s.site ?? DEFAULT_GRADESCOPE_SITE);
        if (items === "logged-out") throw new Error(GRADESCOPE_LOGGED_OUT);
        next.push(...items);
        s.counts = countKinds(items);
      } else if (s.kind === "ed") {
        const { notices, courses } = await fetchEd(s.region ?? "us");
        await kv.set(keys.notices, notices);
        await kv.set(keys.edCourses, courses);
        s.counts = { deadlines: 0, events: 0, notices: notices.length };
      } else {
        const text = await invoke<string>("source_fetch", { id: s.id });
        const { items } = parseIcs(text, s.id, s.kind);
        next.push(...items);
        s.counts = countKinds(items);
        // Counts only, never titles or links: enough to tell a quiet feed from a misread one.
        const inFeed = (re: RegExp) => (text.match(re) ?? []).length;
        log(
          `calendar ${s.kind}: ${inFeed(/^BEGIN:VEVENT/gm)} in feed, ${inFeed(/^UID:event-assignment/gm)} marked as assignments` +
            ` → ${s.counts.deadlines} deadlines, ${s.counts.events} events in range`,
        );
      }
      s.lastSync = Date.now();
      s.lastError = null;
      ok++;
    } catch (e) {
      s.lastError = errorText(e);
      next.push(...previous.filter((i) => i.sourceId === s.id));
      failed++;
    }
  }
  const items = dedupe(next);
  await kv.set(keys.items, items);
  await kv.set(keys.sources, sources);
  await kv.set(keys.lastSync, Date.now());
  await emit("data-updated");
  return { ok, failed, items: items.length };
}

/** Tests the link, stores it in the keychain, and merges its items. Throws a readable message. */
export async function addSource(kind: SourceKind, url: string): Promise<{ source: Source; counts: Counts }> {
  const calendars = (await getSources()).filter((s) => s.kind !== "gradescope" && s.kind !== "ed");
  const same = await invoke<string | null>("source_find", { url, ids: calendars.map((s) => s.id) });
  if (same) throw new Error(`这个日历已经加过了（「${calendars.find((s) => s.id === same)?.name}」）`);
  const text = await invoke<string>("ics_fetch_url", { url });
  const id = crypto.randomUUID();
  const { items, calName } = parseIcs(text, id, kind);
  await invoke("source_save", { id, url });

  const counts = countKinds(items);
  const source: Source = {
    id,
    name: sourceName(kind, url, calName),
    kind,
    addedAt: Date.now(),
    lastSync: Date.now(),
    lastError: null,
    counts,
  };
  await upsertSource(source, items);
  return { source, counts };
}

/**
 * Called whenever the user may have just logged in to Gradescope (on `site`, or the site
 * already connected). Returns the number of assignments found, or null if the built-in
 * window isn't logged in yet.
 */
export async function connectGradescope(site?: string): Promise<number | null> {
  const existing = (await getSources()).find((s) => s.id === GRADESCOPE_SOURCE);
  site ??= existing?.site ?? DEFAULT_GRADESCOPE_SITE;
  const items = await fetchGradescope(site);
  if (items === "logged-out") return null;
  const counts = countKinds(items);
  await upsertSource(
    {
      id: GRADESCOPE_SOURCE,
      name: "Gradescope",
      kind: "gradescope",
      site,
      addedAt: existing?.addedAt ?? Date.now(),
      lastSync: Date.now(),
      lastError: null,
      counts,
    },
    items,
  );
  return counts.deadlines;
}

/**
 * Tests an Ed API token (in `region`, or whichever region it belongs to), stores it in the
 * keychain, and loads announcements. Throws a readable message.
 */
export async function connectEd(token: string, region: EdRegion): Promise<{ name: string; courses: number; notices: number }> {
  const connected = await invoke<{ region: EdRegion; user: string }>("ed_connect", { token, region });
  const user = JSON.parse(connected.user) as EdUserResponse;
  const { notices, courses } = await fetchEd(connected.region);
  const kv = await store();
  await kv.set(keys.notices, notices);
  await kv.set(keys.edCourses, courses);
  await upsertSource(
    {
      id: ED_SOURCE,
      name: `Ed · ${user.user.name}`,
      kind: "ed",
      region: connected.region,
      addedAt: Date.now(),
      lastSync: Date.now(),
      lastError: null,
      counts: { deadlines: 0, events: 0, notices: notices.length },
    },
    [],
  );
  return { name: user.user.name, courses: courses.length, notices: notices.length };
}

export async function removeSource(id: string): Promise<void> {
  const source = (await getSources()).find((s) => s.id === id);
  const kv = await store();
  if (source?.kind === "ed") {
    await invoke("ed_disconnect");
    await kv.set(keys.notices, []);
    await kv.set(keys.edCourses, []);
  } else if (source?.kind === "gradescope") {
    // Forget the saved login; the built-in window stays logged in until you log out there.
    await invoke("gradescope_forget");
  } else {
    await invoke("source_delete", { id });
  }
  await kv.set(
    keys.sources,
    (await getSources()).filter((s) => s.id !== id),
  );
  await kv.set(
    keys.items,
    (await getItems()).filter((i) => i.sourceId !== id),
  );
  await emit("data-updated");
}

/** Adds or replaces a source and its items. */
async function upsertSource(source: Source, items: Item[]): Promise<void> {
  const kv = await store();
  const others = (await getSources()).filter((s) => s.id !== source.id);
  await kv.set(keys.sources, [...others, source]);
  const kept = (await getItems()).filter((i) => i.sourceId !== source.id);
  await kv.set(keys.items, dedupe([...kept, ...items]));
  await kv.set(keys.lastSync, Date.now());
  await emit("data-updated");
}

export async function getNotices(): Promise<Notice[]> {
  return (await (await store()).get<Notice[]>(keys.notices)) ?? [];
}

export async function getEdCourses(): Promise<EdCourse[]> {
  return (await (await store()).get<EdCourse[]>(keys.edCourses)) ?? [];
}

function sourceName(kind: SourceKind, url: string, calName?: string): string {
  let host = "";
  try {
    host = new URL(url.trim().replace(/^webcal:/, "https:")).hostname;
  } catch {
    // keep empty
  }
  if (kind === "canvas") {
    const school = host.split(".")[0];
    return school && school !== "canvas" ? `Canvas · ${school}` : "Canvas";
  }
  if (calName) return calName;
  if (host.includes("google")) return "Google 日历";
  if (host.includes("outlook") || host.includes("office")) return "Outlook 日历";
  return host || "日历";
}
