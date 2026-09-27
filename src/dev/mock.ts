// Stand-ins for the Rust commands when the pages run in a plain browser (design preview).
// Add `?fresh` to a page URL to preview the first-run experience, `?image` to preview a
// single-picture pet instead of the Cloudbun atlas.
import { activeCourses, toNotices, type EdThread, type EdUserResponse } from "../shared/ed";
import { parseCourse, parseDashboard } from "../shared/gradescope";
import { countKinds, dedupe, parseIcs } from "../shared/ics";
import type { KV } from "../shared/store";
import type { CodexPetRef, PetInfo, Source } from "../shared/types";
import { sampleCanvasIcs } from "./sample-ics";
import { sampleEdThreads, sampleEdUser, sampleGradescopeCourse, sampleGradescopeDashboard } from "./sample-services";

const params = new URLSearchParams(location.search);
const fresh = params.has("fresh");
const singleImage = params.has("image");
/** `?image=/.dev-assets/x.jpg` previews a specific picture (keep test pictures in .dev-assets/, which git ignores). */
const imagePath = params.get("image") || "/src-tauri/icons/tray.png";
const listeners = new Map<string, Set<(p: unknown) => void>>();

const PICTURE: PetInfo = {
  kind: "image",
  name: "我的小兔",
  imageFile: "image.png",
  mime: "image/png",
  origin: "upload",
};

const CLOUDBUN: PetInfo = {
  kind: "codex-atlas",
  name: "Cloudbun",
  description: "A sweet, bouncy cloud-rabbit.",
  imageFile: "sprite.webp",
  mime: "image/webp",
  spriteVersion: 2,
  origin: "default",
};

export async function mockListen(event: string, handler: (p: unknown) => void) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event)!.add(handler);
  return () => listeners.get(event)?.delete(handler);
}

export async function mockEmit(event: string, payload?: unknown) {
  listeners.get(event)?.forEach((h) => h(payload));
}

export async function mockInvoke<T>(cmd: string, _args?: Record<string, unknown>): Promise<T> {
  const r = (v: unknown) => v as T;
  switch (cmd) {
    case "get_pet":
      return r(fresh && !sessionStorage.getItem("pet") ? null : singleImage ? PICTURE : CLOUDBUN);
    case "get_pet_image": {
      const file = singleImage ? imagePath : "/src-tauri/resources/pets/cloudbun/spritesheet.webp";
      return r(await (await fetch(file)).arrayBuffer());
    }
    case "use_default_pet":
      sessionStorage.setItem("pet", "1");
      return r(CLOUDBUN);
    case "import_pet":
      throw new Error("预览模式读不了本地文件，请在 App 里试");
    case "list_codex_pets":
      return r([{ id: "cloudbun", name: "Cloudbun", path: "~/.codex/pets/cloudbun" }] satisfies CodexPetRef[]);
    case "ics_fetch_url":
    case "source_fetch":
      await new Promise((ok) => setTimeout(ok, 400));
      return r(sampleCanvasIcs());
    case "selftest_ics_url":
      return r(null);
    case "gradescope_fetch": {
      const path = String(_args?.path ?? "/");
      const course = path.match(/^\/courses\/(\d+)/)?.[1];
      return r({ url: `https://www.gradescope.com${path}`, status: 200, html: course ? sampleGradescopeCourse(course) : sampleGradescopeDashboard() });
    }
    case "ed_connect":
    case "ed_user":
      return r(sampleEdUser());
    case "ed_threads":
      return r(sampleEdThreads(Number(_args?.courseId)));
    case "open_service":
      window.open(String(_args?.url ?? (_args?.name === "ed" ? "https://edstem.org/us/dashboard" : "https://www.gradescope.com/")), "_blank", "noopener");
      return r(undefined);
    default:
      console.debug("[mock]", cmd, _args);
      return r(undefined);
  }
}

/** localStorage-backed store, pre-filled with the sample feed unless `?fresh`. */
export function previewKV(): KV {
  const prefix = fresh ? "studypet-fresh:" : "studypet:";
  const kv: KV = {
    async get<T>(k: string) {
      const raw = localStorage.getItem(prefix + k);
      return raw === null ? undefined : (JSON.parse(raw) as T);
    },
    async set(k, v) {
      localStorage.setItem(prefix + k, JSON.stringify(v));
    },
  };
  if (!fresh) {
    const id = "sample-canvas";
    const { items } = parseIcs(sampleCanvasIcs(), id, "canvas");
    const source: Source = {
      id,
      name: "Canvas · example",
      kind: "canvas",
      addedAt: Date.now() - 3 * 86_400_000,
      lastSync: Date.now() - 4 * 60_000,
      counts: countKinds(items),
    };
    // Gradescope and Ed, as if connected.
    const gsItems = (parseDashboard(sampleGradescopeDashboard()) ?? []).flatMap((c) => parseCourse(sampleGradescopeCourse(c.id), c) ?? []);
    const edUser = JSON.parse(sampleEdUser()) as EdUserResponse;
    const edCourses = activeCourses(edUser);
    const notices = edCourses
      .flatMap((c) => toNotices((JSON.parse(sampleEdThreads(c.id)) as { threads: EdThread[] }).threads, c))
      .sort((a, b) => b.createdAt - a.createdAt);
    const now = Date.now();
    void kv.set("sources", [
      source,
      { id: "gradescope", name: "Gradescope", kind: "gradescope", addedAt: now, lastSync: now, counts: countKinds(gsItems) },
      { id: "ed", name: `Ed · ${edUser.user.name}`, kind: "ed", addedAt: now, lastSync: now, counts: { deadlines: 0, events: 0, notices: notices.length } },
    ]);
    void kv.set("items", dedupe([...items, ...gsItems]));
    void kv.set("notices", notices);
    void kv.set(
      "edCourses",
      edCourses.map((c) => ({
        id: c.id,
        code: c.code,
        name: c.name,
        unseen: (JSON.parse(sampleEdThreads(c.id)) as { threads: EdThread[] }).threads.filter((t) => !t.is_seen).length,
      })),
    );
    void kv.set("lastSync", source.lastSync);
    void kv.set("onboarded", true);
  }
  return kv;
}
