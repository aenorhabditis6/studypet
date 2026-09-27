// Gives a picture pet a living face, automatically: finds its eyes in the uploaded picture and
// has it watch the cursor — the pupils move across the eyes and the face turns a little the
// same way — blink, and make a few expressions.
//
// Eyes are found as a pair of dark, round, similar blobs in the subject that don't touch its
// outline (that rules out outlines, mouths and shadows). A blob with a much darker round core
// is a black pupil in a coloured eye, and the core is the pupil. The eye is everything around
// the pupil that isn't face colour: an eye-white, or a coloured one. The pupil is lifted out,
// its hole filled from the eye around it, and drawn back shifted toward the cursor, clipped to
// the eye. Eyes too small to read at pet size are drawn a little bigger. The face around the
// eyes, with soft edges that keep clear of the outline, slides a few pixels the same way, which
// reads as the head turning. Pictures without such eyes don't get a face rig.

type RGB = [number, number, number];

export type Expression = "open" | "closed" | "happy";

/** Eyes smaller than this on screen (CSS px across) are drawn bigger… */
const MIN_EYE_PX = 15;
/** …by at most this much. */
const MAX_ZOOM = 1.4;
/** Directions the pupil's reach is measured in (clockwise from right). */
const DIRS = 16;

interface Eye {
  /** Centre and radius of the eye: what the lids cover, and what it is enlarged around. */
  ex: number;
  ey: number;
  socket: number;
  /** Pupil centre and radius, in picture px. */
  cx: number;
  cy: number;
  r: number;
  /** How far the pupil may move in each of the DIRS directions. */
  reach: number[];
  /**
   * The eye without its pupil (its alpha is the eye's shape) at (bx, by) — or null for a plain
   * dot eye, whose pupil just moves over the face.
   */
  image: HTMLCanvasElement | null;
  /** The inside of the eye, a little in from its edge: what the pupil shows through. */
  clip: HTMLCanvasElement | null;
  bx: number;
  by: number;
  /** Scratch canvas the size of `image`, for clipping the pupil to the eye. */
  work: HTMLCanvasElement | null;
  /** The lifted-out pupil, and where it sits. */
  patch: HTMLCanvasElement;
  px: number;
  py: number;
  /** Face colour right around the eye (for eyelids) and the pupil's colour (for drawn lines). */
  lid: RGB;
  ink: RGB;
}

interface Point {
  x: number;
  y: number;
}

export class FaceRig {
  readonly canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  /** Where the pupils and the head are now (−1…1 each way), and where they're headed. */
  private gaze: Point = { x: 0, y: 0 };
  private turn: Point = { x: 0, y: 0 };
  private target: Point = { x: 0, y: 0 };
  private expression: Expression = "open";
  private frame = 0;

  private constructor(
    private base: HTMLCanvasElement,
    private eyes: Eye[],
    /** The face around the eyes, and how far it slides when the pet looks all the way over. */
    private face: HTMLCanvasElement | null,
    private head: Point,
    /** How much bigger than in the picture the eyes are drawn. */
    readonly zoom: number,
  ) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = base.width;
    this.canvas.height = base.height;
    this.g = this.canvas.getContext("2d")!;
    this.g.imageSmoothingQuality = "high";
    this.render();
  }

  /**
   * A face rig for this (cut-out) picture, or null if no eyes were found. `shown` is how big
   * the picture appears on screen (CSS px per picture px), for making small eyes readable.
   */
  static detect(source: HTMLCanvasElement, shown = 1): FaceRig | null {
    const g = source.getContext("2d", { willReadFrequently: true });
    if (!g) return null;
    const image = g.getImageData(0, 0, source.width, source.height);
    const pair = findEyes(image);
    if (!pair.length) return null;

    // The picture with the pupils filled in from the eyes around them.
    const erased = new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
    const pupils = pair.map((blob) => pupilCore(image, blob));
    // An eye can't be wider than the distance between the two.
    const apart = Math.hypot(pupils[1].mx - pupils[0].mx, pupils[1].my - pupils[0].my);
    const eyes = pupils.map((pupil) => buildEye(image, erased, pupil, apart));
    const inside = insideDistance(image);
    const room = (e: Eye) => inside[Math.round(e.ey) * image.width + Math.round(e.ex)];
    const [a, b] = eyes;
    const spacing = Math.hypot(b.ex - a.ex, b.ey - a.ey);

    // Small eyes are drawn bigger, as long as they stay apart and inside the outline.
    let zoom = 1;
    if (eyes.every((e) => e.image)) {
      const across = Math.min(a.socket, b.socket) * 2 * shown;
      zoom = Math.max(
        1,
        Math.min(
          MAX_ZOOM,
          MIN_EYE_PX / across,
          (spacing / 2 - 2) / Math.max(a.socket, b.socket),
          ...eyes.map((e) => (room(e) - 2) / e.socket),
        ),
      );
    }
    const face = faceLayer(erased, inside, eyes, spacing, zoom);
    return new FaceRig(toCanvas(erased), eyes, face?.canvas ?? null, face?.head ?? { x: 0, y: 0 }, zoom);
  }

  /** Whether the face turns toward where the pet looks (not just the pupils). */
  get turnsHead(): boolean {
    return this.face !== null;
  }

  /** Look toward a direction (x right, y down, each −1…1; shorter = less far), or ahead (0, 0). */
  look(x: number, y: number) {
    const len = Math.hypot(x, y);
    this.target = len > 1 ? { x: x / len, y: y / len } : { x, y };
    this.animate();
  }

  setExpression(e: Expression) {
    if (e === this.expression) return;
    this.expression = e;
    this.render();
  }

  get currentExpression(): Expression {
    return this.expression;
  }

  /** Eases toward the target a frame at a time: the eyes quickly, the head following behind. */
  private animate() {
    if (this.frame) return;
    const step = () => {
      const t = this.target;
      this.gaze = approach(this.gaze, t, 0.3);
      this.turn = approach(this.turn, t, 0.12);
      this.render();
      const settled = this.gaze.x === t.x && this.gaze.y === t.y && this.turn.x === t.x && this.turn.y === t.y;
      this.frame = settled ? 0 : requestAnimationFrame(step);
    };
    this.frame = requestAnimationFrame(step);
  }

  private render() {
    const g = this.g;
    const fx = this.turn.x * this.head.x;
    const fy = this.turn.y * this.head.y;
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.drawImage(this.base, 0, 0);
    if (this.face) g.drawImage(this.face, fx, fy);

    const { x: gx, y: gy } = this.gaze;
    const angle = Math.atan2(gy, gx);
    for (const eye of this.eyes) {
      g.save();
      // The eye moves with the face, and is drawn `zoom` times bigger around its centre.
      g.translate(eye.ex + fx, eye.ey + fy);
      g.scale(this.zoom, this.zoom);
      g.translate(-eye.ex, -eye.ey);
      if (this.expression === "open") {
        const reach = gx || gy ? reachAt(eye.reach, angle) : 0;
        const ox = eye.px + gx * reach;
        const oy = eye.py + gy * reach;
        if (eye.image && eye.clip && eye.work) {
          // The pupil clipped to the inside of the eye (so it tucks under a rim), over the eye.
          const w = eye.work.getContext("2d")!;
          w.clearRect(0, 0, eye.work.width, eye.work.height);
          w.drawImage(eye.patch, ox - eye.bx, oy - eye.by);
          w.globalCompositeOperation = "destination-in";
          w.drawImage(eye.clip, 0, 0);
          w.globalCompositeOperation = "destination-over";
          w.drawImage(eye.image, 0, 0);
          w.globalCompositeOperation = "source-over";
          g.drawImage(eye.work, eye.bx, eye.by);
        } else {
          g.drawImage(eye.patch, ox, oy);
        }
      } else {
        drawLid(g, eye, this.expression);
      }
      g.restore();
    }
  }
}

/** An eyelid over the whole eye (feathered into the face), then a line: flat when closed, an arch when happy. */
function drawLid(g: CanvasRenderingContext2D, eye: Eye, expression: Expression) {
  const outer = eye.socket + 3;
  const lid = g.createRadialGradient(eye.ex, eye.ey, 0, eye.ex, eye.ey, outer);
  lid.addColorStop(0, css(eye.lid));
  lid.addColorStop((eye.socket + 0.8) / outer, css(eye.lid));
  lid.addColorStop(1, css(eye.lid, 0));
  g.fillStyle = lid;
  g.beginPath();
  g.arc(eye.ex, eye.ey, outer, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = css(eye.ink);
  g.lineWidth = Math.max(1.6, eye.r * 0.45);
  g.lineCap = "round";
  g.beginPath();
  const w = eye.socket * 0.95;
  if (expression === "happy") {
    g.moveTo(eye.ex - w, eye.ey + w * 0.35);
    g.quadraticCurveTo(eye.ex, eye.ey - w * 0.9, eye.ex + w, eye.ey + w * 0.35);
  } else {
    g.moveTo(eye.ex - w, eye.ey);
    g.quadraticCurveTo(eye.ex, eye.ey + w * 0.35, eye.ex + w, eye.ey);
  }
  g.stroke();
}

function approach(from: Point, to: Point, k: number): Point {
  const step = (a: number, b: number) => (Math.abs(b - a) < 0.005 ? b : a + (b - a) * k);
  return { x: step(from.x, to.x), y: step(from.y, to.y) };
}

/** The pupil's reach toward `angle`, between the measured directions. */
function reachAt(reach: number[], angle: number): number {
  const k = ((((angle / (Math.PI * 2)) * DIRS) % DIRS) + DIRS) % DIRS;
  const i = Math.floor(k);
  const f = k - i;
  return reach[i] * (1 - f) + reach[(i + 1) % DIRS] * f;
}

// ---------------------------------------------------------------------------
// Finding the eyes

interface Blob {
  n: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  mx: number;
  my: number;
  pixels: number[];
}

const lum = (px: Uint8ClampedArray, o: number) => 0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2];

function findEyes(image: ImageData): Blob[] {
  const { width: w, height: h, data: px } = image;
  const solid = (i: number) => px[i * 4 + 3] > 128;

  // The subject: its box, area, and typical brightness.
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  const lums: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (!solid(i)) continue;
    const x = i % w;
    const y = (i - x) / w;
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
    if (i % 7 === 0) lums.push(lum(px, i * 4));
  }
  if (x1 < 0 || lums.length < 20) return [];
  const area = lums.length * 7;
  const sw = x1 - x0 + 1;
  const sh = y1 - y0 + 1;
  lums.sort((a, b) => a - b);
  const darkest = Math.min(85, lums[lums.length >> 1] * 0.5);

  // Dark, solid pixels in the upper part of the subject.
  const dark = new Uint8Array(w * h);
  for (let y = y0; y <= y0 + sh * 0.8; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * w + x;
      if (solid(i) && lum(px, i * 4) < darkest) dark[i] = 1;
    }
  }

  // Connected dark blobs that could be pupils: round, a sensible size, not on the outline.
  const seen = new Uint8Array(w * h);
  const blobs: Blob[] = [];
  for (let start = 0; start < w * h; start++) {
    if (!dark[start] || seen[start]) continue;
    let touchesOutline = false;
    const pixels = grow(start, w, h, seen, (n) => {
      if (!solid(n)) touchesOutline = true;
      return dark[n] === 1;
    });
    if (touchesOutline || pixels.length < Math.max(6, area * 0.0003) || pixels.length > area * 0.05) continue;
    const blob = measure(pixels, w);
    const bw = blob.x1 - blob.x0 + 1;
    const bh = blob.y1 - blob.y0 + 1;
    const aspect = bw / bh;
    const fill = pixels.length / (bw * bh);
    if (aspect < 0.45 || aspect > 2.2 || fill < 0.5) continue;
    blobs.push(blob);
  }

  // The best matching pair: similar size, level, a plausible distance apart, high on the face.
  let best: [Blob, Blob] | null = null;
  let bestScore = -Infinity;
  for (let a = 0; a < blobs.length; a++) {
    for (let b = a + 1; b < blobs.length; b++) {
      const p = blobs[a];
      const q = blobs[b];
      const dx = Math.abs(p.mx - q.mx) / sw;
      const dy = Math.abs(p.my - q.my) / sh;
      const sizeRatio = Math.min(p.n, q.n) / Math.max(p.n, q.n);
      if (dx < 0.08 || dx > 0.8 || dy > 0.12 || sizeRatio < 0.4) continue;
      const height = 1 - ((p.my + q.my) / 2 - y0) / sh;
      const score = sizeRatio + (1 - dy * 5) + height * 0.6 + Math.sqrt(Math.min(p.n, q.n) / area) * 4;
      if (score > bestScore) {
        bestScore = score;
        best = p.mx < q.mx ? [p, q] : [q, p];
      }
    }
  }
  return best ?? [];
}

/**
 * A black pupil in a coloured eye shows up as one dark blob with the darker parts of the eye;
 * the pupil is its much darker, round core. Other blobs are the pupil as they are.
 */
function pupilCore(image: ImageData, blob: Blob): Blob {
  const { width: w, height: h, data: px } = image;
  const lums = blob.pixels.map((i) => lum(px, i * 4));
  const sorted = [...lums].sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length * 0.1)];
  const hi = sorted[Math.floor(sorted.length * 0.9)];
  if (hi - lo < 40) return blob;
  const cut = lo + (hi - lo) * 0.4;
  const inCore = new Set(blob.pixels.filter((_, k) => lums[k] <= cut));
  const seed = blob.pixels[lums.indexOf(sorted[0])];
  const core = measure(grow(seed, w, h, new Uint8Array(w * h), (i) => inCore.has(i)), w);
  const bw = core.x1 - core.x0 + 1;
  const bh = core.y1 - core.y0 + 1;
  const round = bw / bh > 0.55 && bw / bh < 1.8 && core.n / (bw * bh) > 0.45;
  return round && core.n >= blob.n * 0.15 ? core : blob;
}

// ---------------------------------------------------------------------------
// Building an eye: its shape, and the pupil lifted out of it

function buildEye(image: ImageData, erased: ImageData, pupil: Blob, apart: number): Eye {
  const { width: w, height: h, data: px } = image;
  const index = (x: number, y: number) => Math.round(Math.min(h - 1, Math.max(0, y))) * w + Math.round(Math.min(w - 1, Math.max(0, x)));
  const at = (x: number, y: number): RGB => {
    const o = index(x, y) * 4;
    return [px[o], px[o + 1], px[o + 2]];
  };
  const cx = (pupil.x0 + pupil.x1) / 2;
  const cy = (pupil.y0 + pupil.y1) / 2;
  const rx = (pupil.x1 - pupil.x0 + 1) / 2;
  const ry = (pupil.y1 - pupil.y0 + 1) / 2;
  const r = (rx + ry) / 2;
  const ink = median(pupil.pixels.map((i) => [px[i * 4], px[i * 4 + 1], px[i * 4 + 2]] as RGB));

  // The face colour: the typical colour in a ring well outside the eye.
  const ringAt = Math.max(r * 4, apart * 0.42);
  const ring: RGB[] = [];
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2;
    const x = cx + Math.cos(a) * ringAt;
    const y = cy + Math.sin(a) * ringAt;
    if (px[index(x, y) * 4 + 3] > 128) ring.push(at(x, y));
  }
  const skin = ring.length ? median(ring) : at(cx, cy - ringAt);

  // The eye: everything joined to the pupil that isn't face colour. Shading on the face can
  // leak out of the eye at a strict threshold, so the first threshold that stays inside a
  // plausible eye wins; if none does, there's no eye to speak of (a dot eye).
  const limit = Math.max(r * 2, apart * 0.5);
  const inEye = new Uint8Array(w * h);
  let region: number[] = [];
  for (const tolerance of [38, 50, 65, 80]) {
    let escaped = 0;
    inEye.fill(0);
    region = grow(pupil.pixels[0], w, h, inEye, (i) => {
      const x = i % w;
      const y = (i - x) / w;
      if (Math.hypot(x - cx, y - cy) > limit) {
        escaped++;
        return false;
      }
      return px[i * 4 + 3] > 128 && colourDist([px[i * 4], px[i * 4 + 1], px[i * 4 + 2]], skin) > tolerance;
    });
    if (escaped < 8) break;
    region = [];
  }
  const socketed = region.length > pupil.n * 1.8;
  if (!socketed) {
    inEye.fill(0);
    for (const i of pupil.pixels) inEye[i] = 1;
  }
  const shape = measure(socketed ? region : pupil.pixels, w);
  const ex = socketed ? shape.mx : cx;
  const ey = socketed ? shape.my : cy;
  const socket = socketed ? Math.sqrt(shape.n / Math.PI) + 0.5 : r + 1;

  // How far the eye reaches from a point in a direction.
  const edge = (x: number, y: number, a: number) => {
    let d = 0;
    while (d < limit && inEye[index(x + Math.cos(a) * d, y + Math.sin(a) * d)]) d += 0.5;
    return d;
  };
  // The pupil shows only a little inside the eye's edge, so it tucks under a rim instead of
  // covering it, and may travel until it's partly tucked under.
  const tuck = Math.max(1, socket * 0.07);
  const reach: number[] = [];
  for (let k = 0; k < DIRS; k++) {
    const a = (k / DIRS) * Math.PI * 2;
    reach.push(socketed ? Math.max(r * 0.25, edge(cx, cy, a) - r * 0.8 - tuck) : r * 0.35);
  }
  // Eyelids take the colour just outside the eye, so they blend into the face.
  const rim: RGB[] = [];
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2;
    const d = edge(ex, ey, a) + 2.5;
    rim.push(at(ex + Math.cos(a) * d, ey + Math.sin(a) * d));
  }
  const lid = median(rim);

  // Lift the pupil (highlights and all) into its own patch, and fill the hole with a smooth
  // blend of the eye around it. Along the pupil's soft edge only the pupil's share is lifted.
  const pad = 3;
  const fx = rx + pad + 1.5;
  const fy = ry + pad + 1.5;
  const around = (x: number, y: number): RGB => {
    const c: RGB = [0, 0, 0];
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const v = at(x + i, y + j);
        c[0] += v[0] / 9;
        c[1] += v[1] / 9;
        c[2] += v[2] / 9;
      }
    }
    return c;
  };
  // Blended across the row and down the column between the two sides of the ring around the
  // pupil; the shorter of the two counts for more.
  const fill = (x: number, y: number): RGB => {
    const dx = Math.min(0.999, Math.abs(x - cx) / fx);
    const dy = Math.min(0.999, Math.abs(y - cy) / fy);
    const hw = fx * Math.sqrt(1 - dy * dy);
    const hh = fy * Math.sqrt(1 - dx * dx);
    const row = mix(around(cx - hw, y), around(cx + hw, y), (x - cx + hw) / (2 * hw));
    const col = mix(around(x, cy - hh), around(x, cy + hh), (y - cy + hh) / (2 * hh));
    return mix(row, col, hw / (hw + hh));
  };
  const px0 = Math.floor(cx - rx - pad);
  const py0 = Math.floor(cy - ry - pad);
  const pw = Math.ceil(rx * 2 + pad * 2) + 2;
  const ph = Math.ceil(ry * 2 + pad * 2) + 2;
  const pdata = new ImageData(pw, ph);
  const out = erased.data;
  const inkLum = lumRGB(ink);
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      const sx = px0 + x;
      const sy = py0 + y;
      if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
      const nx = (sx - cx) / rx;
      const ny = (sy - cy) / ry;
      const beyond = (Math.hypot(nx, ny) - 1) * r;
      if (beyond > pad) continue;
      const under = fill(sx, sy);
      const o = (sy * w + sx) * 4;
      let t = 1;
      if (beyond > -0.75) {
        const span = Math.max(1, lumRGB(under) - inkLum);
        t = Math.min(1, Math.max(0, (lumRGB(under) - lum(px, o)) / span));
      }
      if (t <= 0.02) continue;
      const po = (y * pw + x) * 4;
      for (let c = 0; c < 3; c++) {
        // The pupil's own colour, so that drawn back over the filled hole it looks as before.
        pdata.data[po + c] = t >= 1 ? px[o + c] : Math.min(255, Math.max(0, (px[o + c] - under[c] * (1 - t)) / t));
        out[o + c] = Math.round(under[c]);
      }
      pdata.data[po + 3] = Math.round(px[o + 3] * t);
    }
  }
  const patch = toCanvas(pdata);

  // The eye without its pupil (soft-edged), and the inside of it the pupil shows through.
  const bx = shape.x0 - 2;
  const by = shape.y0 - 2;
  let eyeImage: HTMLCanvasElement | null = null;
  let clip: HTMLCanvasElement | null = null;
  let work: HTMLCanvasElement | null = null;
  if (socketed) {
    const bw = shape.x1 - shape.x0 + 5;
    const bh = shape.y1 - shape.y0 + 5;
    const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && inEye[y * w + x] === 1;
    // How deep inside the eye each pixel is.
    const depth = new Float32Array(bw * bh);
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) depth[y * bw + x] = inside(bx + x, by + y) ? Infinity : 0;
    }
    chamfer(depth, bw, bh);
    const eye = new ImageData(bw, bh);
    const inner = new ImageData(bw, bh);
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const sx = bx + x;
        const sy = by + y;
        if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
        const k = y * bw + x;
        const edgeRing = inside(sx - 1, sy) || inside(sx + 1, sy) || inside(sx, sy - 1) || inside(sx, sy + 1);
        const cover = depth[k] > 0 ? 1 : edgeRing ? 0.45 : 0;
        if (!cover) continue;
        const o = (sy * w + sx) * 4;
        eye.data[k * 4] = out[o];
        eye.data[k * 4 + 1] = out[o + 1];
        eye.data[k * 4 + 2] = out[o + 2];
        eye.data[k * 4 + 3] = Math.round(out[o + 3] * cover);
        inner.data[k * 4 + 3] = Math.round(255 * smoothstep(tuck, tuck + 1.5, depth[k]));
      }
    }
    eyeImage = toCanvas(eye);
    clip = toCanvas(inner);
    work = document.createElement("canvas");
    work.width = bw;
    work.height = bh;
  }
  return { ex, ey, socket, cx, cy, r, reach, image: eyeImage, clip, bx, by, work, patch, px: px0, py: py0, lid, ink };
}

// ---------------------------------------------------------------------------
// The face, for turning the head

/**
 * The face around the eyes with soft edges, and how far it slides when the pet looks all the
 * way to one side — or null when the eyes sit too close to the outline for that to look right.
 */
function faceLayer(erased: ImageData, inside: Float32Array, eyes: Eye[], spacing: number, zoom: number) {
  const { width: w, height: h, data } = erased;
  const feather = Math.max(3, spacing * 0.12);
  const room = Math.min(...eyes.map((e) => inside[Math.round(e.ey) * w + Math.round(e.ex)] - e.socket * zoom)) - feather - 1;
  const slide = Math.min(spacing * 0.12, room);
  if (slide < 1.5) return null;
  // An oval from above the eyes down past where a mouth would be.
  const [a, b] = eyes;
  const fx = (a.ex + b.ex) / 2;
  const fy = (a.ey + b.ey) / 2 + spacing * 0.3;
  const rx = spacing * 1.35;
  const ry = spacing * 1.1;
  const face = new ImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const oval = 1 - smoothstep(0.55, 1, Math.hypot((x - fx) / rx, (y - fy) / ry));
      // Fades out well inside the outline, so the outline itself never moves.
      const k = oval && oval * smoothstep(slide + 1, slide + 1 + feather, inside[i]);
      if (k <= 0) continue;
      const o = i * 4;
      face.data[o] = data[o];
      face.data[o + 1] = data[o + 1];
      face.data[o + 2] = data[o + 2];
      face.data[o + 3] = Math.round(data[o + 3] * k);
    }
  }
  return { canvas: toCanvas(face), head: { x: slide, y: slide * 0.6 } };
}

/** Each pixel's distance to the nearest see-through pixel or the picture's edge (0 outside). */
function insideDistance(image: ImageData): Float32Array {
  const { width: w, height: h, data } = image;
  const d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const x = i % w;
    const y = (i - x) / w;
    const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1;
    d[i] = data[i * 4 + 3] <= 128 ? 0 : edge ? 1 : Infinity;
  }
  return chamfer(d, w, h);
}

/**
 * Turns a map of 0 (outside) and Infinity (inside) into each inside pixel's distance to the
 * outside, in place. The border must not be Infinity.
 */
function chamfer(d: Float32Array, w: number, h: number): Float32Array {
  const D = Math.SQRT2;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (d[i]) d[i] = Math.min(d[i], d[i - 1] + 1, d[i - w] + 1, d[i - w - 1] + D, d[i - w + 1] + D);
    }
  }
  for (let y = h - 2; y > 0; y--) {
    for (let x = w - 2; x > 0; x--) {
      const i = y * w + x;
      if (d[i]) d[i] = Math.min(d[i], d[i + 1] + 1, d[i + w] + 1, d[i + w + 1] + D, d[i + w - 1] + D);
    }
  }
  return d;
}

// ---------------------------------------------------------------------------
// Helpers

/** Flood fill (4-neighbours) from `start` over the pixels `accept` takes, marking them in `seen`. */
function grow(start: number, w: number, h: number, seen: Uint8Array, accept: (i: number) => boolean): number[] {
  const pixels: number[] = [];
  const stack = [start];
  seen[start] = 1;
  while (stack.length) {
    const i = stack.pop()!;
    pixels.push(i);
    const x = i % w;
    for (const n of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < w * (h - 1) ? i + w : -1]) {
      if (n < 0 || seen[n] || !accept(n)) continue;
      seen[n] = 1;
      stack.push(n);
    }
  }
  return pixels;
}

function measure(pixels: number[], w: number): Blob {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  let sx = 0;
  let sy = 0;
  for (const i of pixels) {
    const x = i % w;
    const y = (i - x) / w;
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
    sx += x;
    sy += y;
  }
  return { n: pixels.length, x0, y0, x1, y1, mx: sx / pixels.length, my: sy / pixels.length, pixels };
}

function toCanvas(image: ImageData): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  canvas.getContext("2d")!.putImageData(image, 0, 0);
  return canvas;
}

function median(colours: RGB[]): RGB {
  const channel = (c: 0 | 1 | 2) => {
    const v = colours.map((x) => x[c]).sort((a, b) => a - b);
    return v[v.length >> 1];
  };
  return [channel(0), channel(1), channel(2)];
}

function mix(a: RGB, b: RGB, t: number): RGB {
  const k = Math.min(1, Math.max(0, t));
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

const lumRGB = (c: RGB) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
const colourDist = (a: RGB, b: RGB) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const css = (c: RGB, alpha = 1) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${alpha})`;
