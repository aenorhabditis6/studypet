// Renders the user's pet. Two kinds of pets are supported:
//
// - Codex pets: an 8-column atlas of 192×208 cells, one animation per row
//   (idle, running-right, running-left, waving, jumping, failed, waiting, running, review),
//   plus — in sprite version 2 — two rows of 16 clockwise "look" directions.
//   Rows may use fewer than 8 cells; unused cells are fully transparent, so the frame
//   count of each row is detected from the pixels.
// - A single picture: animated with CSS (breathing, hopping, tilting).
import "./sprite.css";
import { cutout } from "./cutout";
import { FaceRig } from "./face";
import type { PictureMode } from "../shared/types";

export type Anim =
  | "idle"
  | "running-right"
  | "running-left"
  | "waving"
  | "jumping"
  | "failed"
  | "waiting"
  | "running"
  | "review";

const ROWS: Anim[] = [
  "idle",
  "running-right",
  "running-left",
  "waving",
  "jumping",
  "failed",
  "waiting",
  "running",
  "review",
];

/**
 * Frame durations from the Codex pet contract (hatch-pet references/animation-rows.md):
 * every frame gets `each` ms except the last, which gets `last`; idle has its own list.
 */
const TIMING: Record<Anim, { each: number; last: number; list?: number[] }> = {
  idle: { each: 140, last: 320, list: [280, 110, 110, 140, 140, 320] },
  "running-right": { each: 120, last: 220 },
  "running-left": { each: 120, last: 220 },
  waving: { each: 140, last: 280 },
  jumping: { each: 140, last: 280 },
  failed: { each: 140, last: 240 },
  waiting: { each: 150, last: 260 },
  running: { each: 120, last: 220 },
  review: { each: 150, last: 280 },
};

function frameMs(anim: Anim, index: number, count: number): number {
  const t = TIMING[anim];
  if (t.list && count === t.list.length) return t.list[index];
  return index === count - 1 ? t.last : t.each;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Within this distance (CSS px) a pet whose eyes do the looking also leans toward the cursor. */
const NEAR = 420;

/** Moods in which the pet stops to look at you (not while panicking or focused on work). */
const LOOKS_AROUND: Anim[] = ["idle", "waiting"];

/** Leans toward the cursor — a little shift and tilt — or back upright. */
function leanToward(el: HTMLElement, to: Point | null, amount: number) {
  const d = to ? Math.hypot(to.x, to.y) : 0;
  if (!to || !d || !amount) {
    el.style.translate = "";
    el.style.rotate = "";
    return;
  }
  const ux = to.x / d;
  const uy = to.y / d;
  el.style.translate = `${(ux * 5 * amount).toFixed(1)}px ${(uy * 3 * amount).toFixed(1)}px`;
  el.style.rotate = `${(ux * 7 * amount).toFixed(1)}deg`;
}

export interface PetView {
  readonly el: HTMLElement;
  readonly width: number;
  readonly height: number;
  /** The visible body inside `el` (CSS px), for hit testing and placing the bubble. */
  readonly body: Box;
  /** The looping animation that expresses the current mood. */
  setBase(anim: Anim): void;
  /** Plays an animation `loops` times, then returns to the base. */
  play(anim: Anim, loops?: number): Promise<void>;
  /** While being dragged. */
  setMoving(dir: "left" | "right" | null): void;
  /** Look at the cursor (where it is from the pet's eyes, in CSS px), or back ahead. */
  look(to: Point | null): void;
  /** Hold still on the resting pose (tucked away in meeting mode), or resume. */
  freeze(on: boolean): void;
  /** What was set up automatically, for Settings ("背景已去掉", "眼睛会跟着鼠标"). */
  readonly features: string[];
  destroy(): void;
}

export async function createPetView(
  kind: "codex-atlas" | "image",
  imageUrl: string,
  height: number,
  mode: PictureMode = "cutout",
): Promise<PetView> {
  const img = await loadImage(imageUrl);
  if (kind === "codex-atlas") {
    const atlas = readAtlas(img);
    if (!atlas) {
      throw new Error(
        `精灵图的尺寸对不上（${img.naturalWidth}×${img.naturalHeight}）。Codex 宠物需要 8 列、每格 192×208，整张 1536×1872 或 1536×2288`,
      );
    }
    return new AtlasView(img, atlas, height);
  }
  return new ImageView(img, height, mode);
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片加载失败，文件可能损坏了"));
    img.src = url;
  });
}

// ---------------------------------------------------------------------------
// Codex atlas

interface Atlas {
  cols: number;
  rows: number;
  cw: number;
  ch: number;
  /** used[row][col] */
  used: boolean[][];
  /** Union of the idle frames' visible pixels, relative to a cell. */
  body: Box;
}

function readAtlas(img: HTMLImageElement): Atlas | null {
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const cols = 8;
  if (W % cols !== 0) return null;
  const cw = W / cols;
  const ch = Math.round((cw * 208) / 192);
  const rows = Math.round(H / ch);
  if (rows < 1 || Math.abs(rows * ch - H) > rows) return null;

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext("2d", { willReadFrequently: true });
  if (!g) return null;
  g.drawImage(img, 0, 0);
  const px = g.getImageData(0, 0, W, H).data;

  const used: boolean[][] = [];
  let minX = cw;
  let minY = ch;
  let maxX = 0;
  let maxY = 0;
  for (let r = 0; r < rows; r++) {
    used.push([]);
    for (let c = 0; c < cols; c++) {
      let any = false;
      for (let y = 0; y < ch; y += 2) {
        for (let x = 0; x < cw; x += 2) {
          const a = px[((r * ch + y) * W + c * cw + x) * 4 + 3];
          if (a > 24) {
            any = true;
            if (r !== 0) break;
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
          }
        }
        if (any && r !== 0) break;
      }
      used[r].push(any);
    }
  }
  if (!used[0].some(Boolean)) return null;
  return { cols, rows, cw, ch, used, body: { x: minX, y: minY, w: maxX - minX, h: maxY - minY } };
}

interface Step {
  row: number;
  col: number;
  ms: number;
}

const rand = (min: number, max: number) => min + Math.random() * (max - min);

class AtlasView implements PetView {
  readonly features: string[] = [];
  readonly el: HTMLCanvasElement;
  readonly width: number;
  readonly height: number;
  readonly body: Box;
  private g: CanvasRenderingContext2D;
  private frames = new Map<Anim, number[]>();
  private idleRest: number;
  private hasLook: boolean;
  private timer = 0;
  private base: Anim = "idle";
  private once: { anim: Anim; loops: number; done: () => void } | null = null;
  private moving: "left" | "right" | null = null;
  private lookCell: [number, number] | null = null;
  private frozen = false;
  private current = "";

  constructor(
    private img: HTMLImageElement,
    private atlas: Atlas,
    height: number,
  ) {
    const k = height / atlas.ch;
    this.width = Math.round(atlas.cw * k);
    this.height = Math.round(height);
    this.body = {
      x: atlas.body.x * k,
      y: atlas.body.y * k,
      w: atlas.body.w * k,
      h: atlas.body.h * k,
    };

    ROWS.forEach((anim, row) => {
      if (row >= atlas.rows) return;
      const cols = atlas.used[row].flatMap((u, c) => (u ? [c] : []));
      if (cols.length) this.frames.set(anim, cols);
    });
    // The idle row is "6 frames + neutral": the last used cell is the resting pose.
    const idle = this.frames.get("idle") ?? [0];
    this.idleRest = idle[idle.length - 1];
    if (idle.length >= 7) this.frames.set("idle", idle.slice(0, -1));
    this.hasLook = atlas.rows >= 11 && atlas.used[9].every(Boolean) && atlas.used[10].every(Boolean);

    const dpr = window.devicePixelRatio || 1;
    this.el = document.createElement("canvas");
    this.el.className = "pet-sprite";
    this.el.width = Math.round(this.width * dpr);
    this.el.height = Math.round(this.height * dpr);
    this.el.style.width = `${this.width}px`;
    this.el.style.height = `${this.height}px`;
    this.g = this.el.getContext("2d")!;
    this.g.imageSmoothingQuality = "high";
    this.run();
  }

  setBase(anim: Anim) {
    if (anim === this.base) return;
    this.base = anim;
    if (!this.once && !this.moving) this.run();
  }

  play(anim: Anim, loops = 1): Promise<void> {
    if (!this.frames.has(anim) || this.frozen) return Promise.resolve();
    this.once?.done();
    return new Promise((done) => {
      this.once = { anim, loops, done };
      this.run();
    });
  }

  setMoving(dir: "left" | "right" | null) {
    if (dir === this.moving) return;
    this.moving = dir;
    if (!this.once) this.run();
  }

  look(to: Point | null) {
    // Turns toward the cursor wherever it is on screen (not when it's on the pet itself).
    const watching = to !== null && Math.hypot(to.x, to.y) > this.body.w * 0.45 && !this.frozen;
    let cell: [number, number] | null = null;
    if (watching && this.hasLook) {
      const angle = (Math.atan2(to.x, -to.y) * 180) / Math.PI;
      const k = Math.round((((angle % 360) + 360) % 360) / 22.5) % 16;
      cell = k < 8 ? [9, k] : [10, k - 8];
    }
    // Pets drawn without look directions (sprite version 1) lean toward it instead.
    if (!this.hasLook) leanToward(this.el, watching ? to : null, 0.8);
    const changed = String(cell) !== String(this.lookCell);
    this.lookCell = cell;
    if (changed && LOOKS_AROUND.includes(this.base) && !this.once && !this.moving) this.run();
  }

  freeze(on: boolean) {
    if (on === this.frozen) return;
    this.frozen = on;
    if (on) {
      this.lookCell = null;
      leanToward(this.el, null, 0);
      clearTimeout(this.timer);
      this.once?.done();
      this.once = null;
      this.draw(0, this.idleRest);
    } else {
      this.run();
    }
  }

  destroy() {
    clearTimeout(this.timer);
    this.once?.done();
    this.el.remove();
  }

  /** Builds one cycle of steps for whatever should be showing now, and plays it. */
  private run() {
    clearTimeout(this.timer);
    if (this.frozen) return;
    const steps = this.cycle();
    let i = 0;
    const step = () => {
      if (i >= steps.length) return this.cycleEnded();
      const s = steps[i++];
      this.draw(s.row, s.col);
      this.timer = window.setTimeout(step, s.ms);
    };
    step();
  }

  private cycleEnded() {
    if (this.once) {
      this.once.loops -= 1;
      if (this.once.loops <= 0) {
        const done = this.once.done;
        this.once = null;
        done();
      }
    }
    this.run();
  }

  private cycle(): Step[] {
    const seq = (anim: Anim) => {
      const row = ROWS.indexOf(anim);
      const cols = this.frames.get(anim) ?? [];
      return cols.map((col, i) => ({ row, col, ms: frameMs(anim, i, cols.length) }));
    };
    if (this.once) return seq(this.once.anim);
    if (this.moving) {
      const s = seq(this.moving === "left" ? "running-left" : "running-right");
      if (s.length) return s;
    }
    if (this.lookCell && LOOKS_AROUND.includes(this.base)) {
      return [{ row: this.lookCell[0], col: this.lookCell[1], ms: 400 }];
    }
    const rest = (row: number, col: number, min: number, max: number) => ({ row, col, ms: rand(min, max) });
    switch (this.base) {
      case "idle":
        return [...seq("idle"), rest(0, this.idleRest, 2200, 5200)];
      case "waiting": {
        const s = seq("waiting");
        return s.length ? [...s, rest(s[0].row, s[0].col, 500, 1500)] : this.fallbackIdle();
      }
      case "review": {
        const s = seq("review");
        return s.length ? [...s, rest(s[0].row, s[0].col, 900, 2200)] : this.fallbackIdle();
      }
      default: {
        const s = seq(this.base);
        return s.length ? s : this.fallbackIdle();
      }
    }
  }

  private fallbackIdle(): Step[] {
    const cols = this.frames.get("idle") ?? [];
    return [...cols.map((col, i) => ({ row: 0, col, ms: frameMs("idle", i, cols.length) })), { row: 0, col: this.idleRest, ms: 3000 }];
  }

  private draw(row: number, col: number) {
    const key = `${row}:${col}`;
    if (key === this.current) return;
    this.current = key;
    const { cw, ch } = this.atlas;
    this.g.clearRect(0, 0, this.el.width, this.el.height);
    this.g.drawImage(this.img, col * cw, row * ch, cw, ch, 0, 0, this.el.width, this.el.height);
  }
}

// ---------------------------------------------------------------------------
// Single picture

/** How long each one-off animation of a picture pet lasts (ms). */
const ONCE_MS: Partial<Record<Anim | IdleAct, number>> = {
  waving: 900,
  jumping: 800,
  failed: 1100,
  hop: 560,
  wiggle: 720,
  lean: 1300,
  squish: 520,
};

/** Little things a picture pet does now and then while idle, so it feels alive. */
type IdleAct = "hop" | "wiggle" | "lean" | "squish";
const IDLE_ACTS: IdleAct[] = ["hop", "wiggle", "lean", "squish"];

class ImageView implements PetView {
  readonly el: HTMLDivElement;
  readonly width: number;
  readonly height: number;
  readonly body: Box;
  /** Leans toward the cursor; the animated picture sits inside it. */
  private lookLayer: HTMLDivElement;
  /** Moving eyes, blinks and expressions, when the picture's eyes could be found. */
  private rig: FaceRig | null;
  private onceTimer = 0;
  private idleTimer = 0;
  private blinkTimer = 0;
  private glanceTimer = 0;
  /** Whether it's watching the cursor right now (rather than looking ahead). */
  private following = false;
  private pending: (() => void) | null = null;
  readonly features: string[] = [];

  constructor(img: HTMLImageElement, height: number, mode: PictureMode) {
    let canvas: HTMLCanvasElement;
    if (mode === "original") {
      // As uploaded: no background removal, no face rig — just the motions.
      canvas = asCanvas(img);
      this.rig = null;
      this.features.push("原图");
    } else {
      // Plain backgrounds (photos, stickers on white) are removed and the picture cropped.
      const { canvas: cut, removed } = cutout(img);
      this.rig = FaceRig.detect(cut, fit(cut, height).height / cut.height);
      canvas = this.rig ? this.rig.canvas : cut;
      if (removed) this.features.push("背景已自动去掉");
      if (!this.rig) this.features.push("没找到眼睛，只能整体动");
      else {
        this.features.push("眼睛会跟着鼠标 👀");
        if (this.rig.turnsHead) this.features.push("会转头看你");
        if (this.rig.zoom > 1.05) this.features.push("眼睛放大了一点，眼神更清楚");
      }
    }
    ({ width: this.width, height: this.height } = fit(canvas, height));
    this.body = { x: 0, y: 0, w: this.width, h: this.height };

    this.el = document.createElement("div");
    this.el.className = "pet-image";
    this.el.style.width = `${this.width}px`;
    this.el.style.height = `${this.height}px`;
    this.lookLayer = document.createElement("div");
    this.lookLayer.className = "pet-look";
    canvas.className = "pet-pic";
    this.lookLayer.append(canvas);
    this.el.append(this.lookLayer);
    this.el.dataset.base = "idle";
    this.scheduleIdle();
    this.scheduleBlink();
  }

  setBase(anim: Anim) {
    this.el.dataset.base = anim;
  }

  play(anim: Anim | IdleAct, loops = 1): Promise<void> {
    if ("frozen" in this.el.dataset) return Promise.resolve();
    this.pending?.();
    clearTimeout(this.onceTimer);
    // Restart the animation even if the same one is already showing.
    delete this.el.dataset.once;
    void this.el.offsetWidth;
    this.el.dataset.once = anim;
    this.el.style.setProperty("--loops", String(loops));
    // Happy ^ ^ eyes only when celebrating; otherwise the eyes stay open.
    const happy = anim === "jumping";
    if (happy) this.rig?.setExpression("happy");
    return new Promise((done) => {
      this.pending = done;
      this.onceTimer = window.setTimeout(() => {
        delete this.el.dataset.once;
        if (happy) this.rig?.setExpression("open");
        this.pending = null;
        done();
      }, (ONCE_MS[anim] ?? 800) * loops);
    });
  }

  setMoving(dir: "left" | "right" | null) {
    if (dir) this.el.dataset.moving = dir;
    else delete this.el.dataset.moving;
  }

  freeze(on: boolean) {
    if (on) {
      this.el.dataset.frozen = "";
      delete this.el.dataset.once;
      this.look(null); // still, eyes open, looking ahead
    } else {
      delete this.el.dataset.frozen;
    }
  }

  look(to: Point | null) {
    clearTimeout(this.glanceTimer);
    this.following = to !== null;
    const d = to ? Math.hypot(to.x, to.y) : 0;
    // The eyes follow the cursor anywhere on screen: all the way over once it's a pet's height
    // away, less when it's on the pet itself.
    if (to) this.rig?.look(to.x / Math.max(d, this.height), to.y / Math.max(d, this.height));
    else this.rig?.look(0, 0);
    // The body leans toward it. Without eyes that's how it looks, so wherever the cursor is;
    // with eyes (which already follow), just a little while the cursor is close by.
    const watching = to !== null && d > this.width * 0.45 && !("frozen" in this.el.dataset);
    leanToward(this.lookLayer, watching ? to : null, this.rig ? (d < NEAR ? 0.5 : 0) : 1);
  }

  destroy() {
    clearTimeout(this.onceTimer);
    clearTimeout(this.idleTimer);
    clearTimeout(this.blinkTimer);
    clearTimeout(this.glanceTimer);
    this.pending?.();
    this.el.remove();
  }

  /** Looks off to one side for a moment, as if something caught its eye. */
  private glance(rig: FaceRig) {
    const side = Math.random() < 0.5 ? -1 : 1;
    rig.look(side * rand(0.6, 1), rand(-0.4, 0.3));
    this.glanceTimer = window.setTimeout(() => {
      if (!this.following) rig.look(0, 0);
    }, rand(900, 1800));
  }

  /** An occasional quick blink — the eyes stay open nearly all the time. */
  private scheduleBlink() {
    if (!this.rig) return;
    const rig = this.rig;
    this.blinkTimer = window.setTimeout(() => {
      const awake = !("frozen" in this.el.dataset) && rig.currentExpression === "open";
      if (awake) {
        rig.setExpression("closed");
        window.setTimeout(() => {
          if (rig.currentExpression === "closed") rig.setExpression("open");
        }, 100);
      }
      this.scheduleBlink();
    }, rand(9000, 18000));
  }

  /** Every few seconds while idle: a hop, a wiggle, a lean or a squish — or a glance around. */
  private scheduleIdle() {
    this.idleTimer = window.setTimeout(() => {
      const d = this.el.dataset;
      const idle = !("once" in d) && !("moving" in d) && !("frozen" in d) && (d.base === "idle" || d.base === "waiting");
      if (idle && this.rig && !this.following && Math.random() < 0.4) this.glance(this.rig);
      else if (idle) void this.play(IDLE_ACTS[Math.floor(Math.random() * IDLE_ACTS.length)]);
      this.scheduleIdle();
    }, rand(3500, 8000));
  }
}

/** A picture's size on screen: `height` tall, but no wider than 1.4 × that (for very wide pictures). */
function fit(picture: { width: number; height: number }, height: number) {
  const aspect = picture.width / picture.height || 1;
  const h = Math.round(aspect * height > height * 1.4 ? (height * 1.4) / aspect : height);
  return { width: Math.round(h * aspect), height: h };
}

/** A picture drawn onto a canvas as-is (for "original" mode), at most 480 px on its long side. */
function asCanvas(img: HTMLImageElement): HTMLCanvasElement {
  const k = Math.min(1, 480 / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.naturalWidth * k));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * k));
  canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}
