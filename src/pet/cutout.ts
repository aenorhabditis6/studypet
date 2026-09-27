// Turns an uploaded picture into a pet: removes a plain background (a product photo, a
// sticker on white) and crops to the subject. Pictures that already have transparency are
// just cropped; busy backgrounds are left alone — upload a transparent PNG for those.

export interface Cutout {
  canvas: HTMLCanvasElement;
  /** Whether a background was removed (for telling the user). */
  removed: boolean;
}

/** Longest side the picture is processed at; plenty for a ~150 px pet on a Retina screen. */
const MAX_SIDE = 480;
/** Neighbouring background pixels differ by less than this (follows gradients and vignettes). */
const STEP_TOL = 10;
/** …and never stray further than this from the border's colour (stops at the subject). */
const BG_TOL = 60;

export function cutout(img: HTMLImageElement): Cutout {
  const k = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * k));
  const h = Math.max(1, Math.round(img.naturalHeight * k));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(img, 0, 0, w, h);
  const image = g.getImageData(0, 0, w, h);
  const px = image.data;

  const border: number[] = [];
  for (let x = 0; x < w; x++) border.push(x, (h - 1) * w + x);
  for (let y = 1; y < h - 1; y++) border.push(y * w, y * w + w - 1);

  // Already a cut-out (transparent edges): nothing to remove.
  const clearEdges = border.filter((i) => px[i * 4 + 3] < 32).length;
  if (clearEdges > border.length * 0.6) return { canvas: crop(canvas, image), removed: false };

  const bg = medianColor(px, border);
  const spread = border.reduce((sum, i) => sum + dist(px, i * 4, bg), 0) / border.length;
  if (spread > 45) return { canvas: crop(canvas, image), removed: false };

  // Flood-fill the background in from the edges.
  const gone = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;
  for (const i of border) {
    if (!gone[i] && dist(px, i * 4, bg) < BG_TOL) {
      gone[i] = 1;
      queue[tail++] = i;
    }
  }
  while (head < tail) {
    const i = queue[head++];
    const x = i % w;
    const y = (i - x) / w;
    const next = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
    for (const n of next) {
      if (n < 0 || gone[n]) continue;
      if (distPx(px, n * 4, i * 4) < STEP_TOL && dist(px, n * 4, bg) < BG_TOL) {
        gone[n] = 1;
        queue[tail++] = n;
      }
    }
  }
  if (tail < w * h * 0.05) return { canvas: crop(canvas, image), removed: false };

  // Clear it, and soften the outline so no light halo is left around the subject.
  for (let i = 0; i < w * h; i++) {
    if (gone[i]) {
      px[i * 4 + 3] = 0;
      continue;
    }
    const x = i % w;
    const edge = (x > 0 && gone[i - 1]) || (x < w - 1 && gone[i + 1]) || (i >= w && gone[i - w]) || (i < w * (h - 1) && gone[i + w]);
    if (edge) px[i * 4 + 3] = Math.round(px[i * 4 + 3] * Math.min(1, Math.max(0.15, (dist(px, i * 4, bg) - 12) / 70)));
  }
  g.putImageData(image, 0, 0);
  return { canvas: crop(canvas, image), removed: true };
}

/** Crops to the visible pixels, with a little room for animations. */
function crop(canvas: HTMLCanvasElement, image: ImageData): HTMLCanvasElement {
  const { width: w, height: h, data } = image;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 24) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }
  if (maxX < 0) return canvas;
  const pad = Math.round(Math.max(maxX - minX, maxY - minY) * 0.03);
  const x0 = Math.max(0, minX - pad);
  const y0 = Math.max(0, minY - pad);
  const x1 = Math.min(w, maxX + pad + 1);
  const y1 = Math.min(h, maxY + pad + 1);
  const out = document.createElement("canvas");
  out.width = x1 - x0;
  out.height = y1 - y0;
  out.getContext("2d")!.drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

function medianColor(px: Uint8ClampedArray, pixels: number[]): [number, number, number] {
  const channel = (c: number) => {
    const v = pixels.map((i) => px[i * 4 + c]).sort((a, b) => a - b);
    return v[v.length >> 1];
  };
  return [channel(0), channel(1), channel(2)];
}

/**
 * Colour difference that weighs hue/saturation (chroma) well above brightness: a studio
 * background and its shadows are grey at every brightness, while a pale highlight on a
 * coloured subject is still clearly coloured.
 */
function diff(r: number, g: number, b: number): number {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  const cb = -0.169 * r - 0.331 * g + 0.5 * b;
  const cr = 0.5 * r - 0.419 * g - 0.081 * b;
  return Math.hypot(y, 2.5 * cb, 2.5 * cr);
}

function dist(px: Uint8ClampedArray, o: number, c: [number, number, number]): number {
  return diff(px[o] - c[0], px[o + 1] - c[1], px[o + 2] - c[2]);
}

function distPx(px: Uint8ClampedArray, a: number, b: number): number {
  return diff(px[a] - px[b], px[a + 1] - px[b + 1], px[a + 2] - px[b + 2]);
}
