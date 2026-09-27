// Moving the pet window around the screen.
//
// Dragging is done here rather than with the native window drag. The window is taller than
// the pet (room for the bubble above or below) and may hang off the left, right and bottom
// edges — but macOS never lets a window's top go above the menu bar. So near the top, the
// window stays put and the pet is lifted inside it instead ("lift"), letting it reach the
// very top of the screen.
//
// Throwing the pet against the left or right edge tucks it away ("meeting mode"): only a
// sliver of it and a small dot stay visible, and it goes silent until pulled back out.
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { availableMonitors, getCurrentWindow, primaryMonitor, type Monitor } from "@tauri-apps/api/window";
import { inTauri } from "../shared/bridge";
import { keys, store } from "../shared/store";
import type { Box } from "./sprite";

export type Side = "left" | "right";

/** CSS px of the pet left visible when tucked into an edge. */
const PEEK = 18;

interface Saved {
  /** Pet body centre, physical screen px. */
  x: number;
  y: number;
  tucked?: Side | null;
}

export interface MotionHost {
  /** Pet body in window CSS px (including any lift). */
  body(): Box;
  /** How far the pet can be lifted inside the window (CSS px). */
  maxLift(): number;
  /** Re-lay out with the pet raised this many CSS px above its usual place. */
  setLift(lift: number): void;
  onDragStart(): void;
  onDragMove(dir: "left" | "right" | null): void;
  onTuck(side: Side | null): void;
  /** While dragging, keep the whole window taking mouse events (no click-through). */
  holdMouse(on: boolean): void;
}

export class Motion {
  /** Window top-left, physical px. */
  pos = { x: 0, y: 0 };
  scale = window.devicePixelRatio || 1;
  tucked: Side | null = null;
  /** CSS px the pet is currently raised inside the window. */
  private lift = 0;
  private monitor: Monitor | null = null;
  private frame = 0;
  private pending: { x: number; y: number } | null = null;

  constructor(private host: MotionHost) {}

  /** Puts the pet back where it was left (if that's still on a screen), else bottom-right. */
  async place() {
    if (!inTauri) return;
    const saved = await (await store()).get<Saved>(keys.petAt);
    const monitors = await availableMonitors();
    const home = saved && monitors.find((m) => contains(m, saved.x, saved.y));
    if (saved && home) {
      this.monitor = home;
      this.scale = home.scaleFactor;
      await this.moveBodyCenterTo(saved.x, saved.y);
      if (saved.tucked) await this.tuck(saved.tucked);
      return;
    }
    const m = (await primaryMonitor()) ?? monitors[0];
    if (!m) return;
    this.monitor = m;
    this.scale = m.scaleFactor;
    const b = this.host.body();
    const wa = m.workArea;
    await this.moveBodyCenterTo(
      wa.position.x + wa.size.width - (b.w / 2 + 24) * this.scale,
      wa.position.y + wa.size.height - (b.h / 2 + 8) * this.scale,
    );
  }

  /** Starts following the mouse; ends on mouseup (tucking if dropped past a side edge). */
  beginDrag(start: MouseEvent) {
    // Where the window would be without the lift, so dragging back down undoes it smoothly.
    const from = { sx: start.screenX, sy: start.screenY, wx: this.pos.x, wy: this.pos.y - this.lift * this.scale };
    let lastX = start.screenX;
    this.host.onDragStart();
    this.host.holdMouse(true);
    const move = (e: MouseEvent) => {
      this.setPos(from.wx + (e.screenX - from.sx) * this.scale, from.wy + (e.screenY - from.sy) * this.scale);
      if (Math.abs(e.screenX - lastX) > 1) this.host.onDragMove(e.screenX < lastX ? "left" : "right");
      lastX = e.screenX;
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      this.host.holdMouse(false);
      this.host.onDragMove(null);
      void this.dropped();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  /** Top of the pet body on screen, and the top of its monitor (physical px): room for a bubble above? */
  roomAbove(): number {
    const top = this.monitor ? this.monitor.workArea.position.y : 0;
    return (this.pos.y + this.host.body().y * this.scale - top) / this.scale;
  }

  async untuck() {
    if (!this.tucked) return;
    const side = this.tucked;
    this.tucked = null;
    const m = this.monitor;
    const b = this.host.body();
    if (m) {
      const x = side === "left" ? m.position.x + (b.w / 2 + 12) * this.scale : m.position.x + m.size.width - (b.w / 2 + 12) * this.scale;
      await this.moveBodyCenterTo(x, this.bodyCenter().y);
    }
    this.host.onTuck(null);
    await this.save();
  }

  private async dropped() {
    await this.flush();
    const center = this.bodyCenter();
    const monitors = await availableMonitors();
    const m = monitors.find((mon) => contains(mon, center.x, center.y)) ?? nearest(monitors, center) ?? this.monitor;
    if (m) {
      this.monitor = m;
      this.scale = m.scaleFactor;
    }
    const b = this.host.body();
    const left = this.pos.x + b.x * this.scale;
    const right = left + b.w * this.scale;
    const slack = b.w * this.scale * 0.2;
    if (m && left < m.position.x - slack) await this.tuck("left");
    else if (m && right > m.position.x + m.size.width + slack) await this.tuck("right");
    else if (this.tucked) {
      this.tucked = null;
      this.host.onTuck(null);
    }
    await this.save();
  }

  private async tuck(side: Side) {
    const m = this.monitor;
    if (!m) return;
    const b = this.baseBody();
    const s = this.scale;
    const x = side === "left" ? m.position.x + PEEK * s - (b.x + b.w) * s : m.position.x + m.size.width - PEEK * s - b.x * s;
    // Keep the whole body vertically on screen so the sliver is findable.
    const minY = m.workArea.position.y - b.y * s;
    const maxY = m.workArea.position.y + m.workArea.size.height - (b.y + b.h) * s;
    const y = Math.min(Math.max(this.pos.y - this.lift * s, minY), maxY);
    this.setPos(x, y);
    await this.flush();
    this.tucked = side;
    this.host.onTuck(side);
  }

  private bodyCenter() {
    const b = this.host.body();
    return { x: this.pos.x + (b.x + b.w / 2) * this.scale, y: this.pos.y + (b.y + b.h / 2) * this.scale };
  }

  private async moveBodyCenterTo(x: number, y: number) {
    const b = this.baseBody();
    this.setPos(x - (b.x + b.w / 2) * this.scale, y - (b.y + b.h / 2) * this.scale);
    await this.flush();
  }

  /** The body where it sits with no lift. */
  private baseBody(): Box {
    const b = this.host.body();
    return { ...b, y: b.y + this.lift };
  }

  private async save() {
    const c = this.bodyCenter();
    await (await store()).set(keys.petAt, { x: Math.round(c.x), y: Math.round(c.y), tucked: this.tucked } satisfies Saved);
  }

  /**
   * Moves the window so that, without lift, its top-left would be at (x, y). Above the
   * menu bar the window stops and the pet is lifted instead. Coalesces moves to one per frame.
   */
  private setPos(x: number, y: number) {
    const top = this.monitor ? this.monitor.workArea.position.y : -Infinity;
    let lift = 0;
    if (y < top) {
      lift = Math.min(this.host.maxLift(), (top - y) / this.scale);
      y = top;
    }
    if (Math.abs(lift - this.lift) > 0.5 || (lift === 0 && this.lift !== 0)) {
      this.lift = lift;
      this.host.setLift(lift);
    }
    this.pos = { x: Math.round(x), y: Math.round(y) };
    this.pending = this.pos;
    if (!this.frame) this.frame = requestAnimationFrame(() => void this.flush());
  }

  private async flush() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    const p = this.pending;
    this.pending = null;
    if (p && inTauri) await getCurrentWindow().setPosition(new PhysicalPosition(p.x, p.y));
  }
}

function contains(m: Monitor, x: number, y: number) {
  return x >= m.position.x && y >= m.position.y && x < m.position.x + m.size.width && y < m.position.y + m.size.height;
}

function nearest(monitors: Monitor[], p: { x: number; y: number }): Monitor | undefined {
  const dist = (m: Monitor) => {
    const cx = Math.min(Math.max(p.x, m.position.x), m.position.x + m.size.width);
    const cy = Math.min(Math.max(p.y, m.position.y), m.position.y + m.size.height);
    return Math.hypot(p.x - cx, p.y - cy);
  };
  return [...monitors].sort((a, b) => dist(a) - dist(b))[0];
}
