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

const FRAME_MS: Record<Anim, number> = {
  idle: 140,
  "running-right": 85,
  "running-left": 85,
  waving: 130,
  jumping: 95,
  failed: 130,
  waiting: 150,
  running: 100,
  review: 160,
};

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
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
  /** Look toward a direction (degrees clockwise from up), or stop looking. */
  look(angle: number | null): void;
  /** Hold still on the resting pose (tucked away in meeting mode), or resume. */
  freeze(on: boolean): void;
  destroy(): void;
}

export async function createPetView(
  kind: "codex-atlas" | "image",
  imageUrl: string,
  height: number,
): Promise<PetView> {
  const img = await loadImage(imageUrl);
  if (kind === "codex-atlas") {
    const atlas = readAtlas(img);
    if (atlas) return new AtlasView(img, atlas, height);
  }
  return new ImageView(img, height);
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

  look(angle: number | null) {
    let cell: [number, number] | null = null;
    if (angle !== null && this.hasLook) {
      const k = Math.round((((angle % 360) + 360) % 360) / 22.5) % 16;
      cell = k < 8 ? [9, k] : [10, k - 8];
    }
    const changed = String(cell) !== String(this.lookCell);
    this.lookCell = cell;
    if (changed && this.base === "idle" && !this.once && !this.moving) this.run();
  }

  freeze(on: boolean) {
    if (on === this.frozen) return;
    this.frozen = on;
    if (on) {
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
    const seq = (anim: Anim, ms = FRAME_MS[anim]) => {
      const row = ROWS.indexOf(anim);
      return (this.frames.get(anim) ?? []).map((col) => ({ row, col, ms }));
    };
    if (this.once) return seq(this.once.anim);
    if (this.moving) {
      const s = seq(this.moving === "left" ? "running-left" : "running-right");
      if (s.length) return s;
    }
    if (this.lookCell && this.base === "idle") {
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
    return [...(this.frames.get("idle") ?? []).map((col) => ({ row: 0, col, ms: FRAME_MS.idle })), { row: 0, col: this.idleRest, ms: 3000 }];
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
  private onceTimer = 0;
  private idleTimer = 0;
  private pending: (() => void) | null = null;

  constructor(img: HTMLImageElement, height: number) {
    // Plain backgrounds (photos, stickers on white) are removed and the picture cropped.
    const { canvas, removed } = cutout(img);
    const aspect = canvas.width / canvas.height || 1;
    // Fit into height × (1.4 · height) so very wide pictures don't overflow the window.
    const maxW = height * 1.4;
    this.height = Math.round(aspect * height > maxW ? maxW / aspect : height);
    this.width = Math.round(this.height * aspect);
    this.body = { x: 0, y: 0, w: this.width, h: this.height };
    this.info = removed ? "background removed" : "as uploaded";

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
  }

  /** "background removed" or "as uploaded". */
  readonly info: string;

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
    return new Promise((done) => {
      this.pending = done;
      this.onceTimer = window.setTimeout(() => {
        delete this.el.dataset.once;
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
    } else {
      delete this.el.dataset.frozen;
    }
  }

  look(angle: number | null) {
    if (angle === null) {
      this.lookLayer.style.translate = "";
      this.lookLayer.style.rotate = "";
      return;
    }
    const rad = (angle * Math.PI) / 180;
    this.lookLayer.style.translate = `${(Math.sin(rad) * 5).toFixed(1)}px ${(-Math.cos(rad) * 3).toFixed(1)}px`;
    this.lookLayer.style.rotate = `${(Math.sin(rad) * 7).toFixed(1)}deg`;
  }

  destroy() {
    clearTimeout(this.onceTimer);
    clearTimeout(this.idleTimer);
    this.pending?.();
    this.el.remove();
  }

  /** Every few seconds while idle: a hop, a wiggle, a lean or a squish. */
  private scheduleIdle() {
    this.idleTimer = window.setTimeout(() => {
      const d = this.el.dataset;
      const idle = !("once" in d) && !("moving" in d) && !("frozen" in d) && (d.base === "idle" || d.base === "waiting");
      if (idle) void this.play(IDLE_ACTS[Math.floor(Math.random() * IDLE_ACTS.length)]);
      this.scheduleIdle();
    }, rand(3500, 8000));
  }
}
