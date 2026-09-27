// Browser-only controls for eyeballing the pet's moods and animations.
import type { Level } from "../shared/agenda";
import type { Anim, PetView } from "../pet/sprite";

export interface PreviewApi {
  view: PetView;
  speak: (t: string) => void;
  setLevel: (l: Level) => void;
  tuck: (side: "left" | "right" | null) => void;
  pomodoro: () => void;
  focus: () => void;
  stop: () => void;
  bubbleBelow: (on: boolean) => void;
}

export function mountPreview(api: PreviewApi) {
  const bar = document.createElement("div");
  bar.style.cssText =
    "position:fixed;left:280px;top:12px;display:flex;flex-direction:column;gap:6px;font:12px -apple-system,sans-serif";
  const row = (label: string, buttons: [string, () => void][]) => {
    const r = document.createElement("div");
    r.style.cssText = "display:flex;gap:4px;align-items:center;flex-wrap:wrap";
    const l = document.createElement("b");
    l.textContent = label;
    l.style.width = "56px";
    r.append(l);
    for (const [text, fn] of buttons) {
      const b = document.createElement("button");
      b.textContent = text;
      b.onclick = fn;
      r.append(b);
    }
    bar.append(r);
  };
  const levels: Level[] = ["empty", "calm", "heads-up", "soon", "urgent", "overdue"];
  row("mood", levels.map((l) => [l, () => api.setLevel(l)]));
  const anims: Anim[] = ["waving", "jumping", "failed", "review", "running", "waiting"];
  row("play", anims.map((a) => [a, () => void api.view.play(a, 2)]));
  row("drag", [
    ["← left", () => api.view.setMoving("left")],
    ["right →", () => api.view.setMoving("right")],
    ["stop", () => api.view.setMoving(null)],
  ]);
  row(
    "look",
    [0, 45, 90, 135, 180, 225, 270, 315].map((a) => [`${a}°`, () => api.view.look(a)] as [string, () => void]).concat([["off", () => api.view.look(null)]]),
  );
  row("say", [["long text", () => api.speak("Reading Response 4（ENGL 150）明天 20:00 截止～今天先做一小部分？我陪你一起，做完奖励自己一杯奶茶")]]);
  row("bubble", [
    ["above", () => api.bubbleBelow(false)],
    ["below", () => api.bubbleBelow(true)],
  ]);
  row("session", [
    ["🍅 pomodoro", api.pomodoro],
    ["🔒 focus", api.focus],
    ["stop", api.stop],
  ]);
  row("meeting", [
    ["tuck left", () => api.tuck("left")],
    ["tuck right", () => api.tuck("right")],
    ["untuck", () => api.tuck(null)],
  ]);
  document.body.append(bar);
}
