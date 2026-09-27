// Pomodoros, focus mode, and health nudges.
//
// A pomodoro is followed by a break; open-ended focus mode lasts until turned off. While
// either is on, the pet keeps quiet except for deadline and class alarms, and (if enabled)
// the apps in Settings → focus are "locked": hidden whenever they come to the front.
import { errorText, inTauri, invoke, log } from "../shared/bridge";
import * as lines from "../shared/lines";
import { keys, store } from "../shared/store";
import type { Session, Settings } from "../shared/types";

const MIN = 60_000;

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

export interface SessionHost {
  settings(): Settings;
  say(text: string, action?: { label: string; run: () => void }): void;
  celebrate(): void;
  /** Before a pomodoro or focus session starts: be visible (out of meeting mode). */
  showUp(): Promise<void>;
  /** The session changed (or a second passed): redraw the timer, posture, etc. */
  changed(session: Session | null): void;
}

export class Sessions {
  current: Session | null = null;
  private timer = 0;
  private dndWarned = false;

  constructor(private host: SessionHost) {}

  /** After a restart or a settings reload: continue (or quietly finish) what was running. */
  async restore() {
    const saved = (await (await store()).get<Session | null>(keys.session)) ?? null;
    if (!saved) return;
    if (saved.endsAt && saved.endsAt <= Date.now()) {
      await this.set(null);
      return;
    }
    this.current = saved;
    if (saved.lock) await this.lockApps(true, false);
    this.startClock();
    this.host.changed(saved);
  }

  /** Pomodoros and focus mode, not breaks: the pet should stay quiet. */
  get focusing(): boolean {
    return this.current?.kind === "pomodoro" || this.current?.kind === "focus";
  }

  async startPomodoro(minutes: number) {
    await this.host.showUp();
    const lock = this.host.settings().pomodoro.lockApps;
    await this.replace({ kind: "pomodoro", startedAt: Date.now(), endsAt: Date.now() + minutes * MIN, lock });
    this.host.say(lines.pomodoroStart(minutes, lock && this.hasApps()));
  }

  async startFocus() {
    await this.host.showUp();
    await this.replace({ kind: "focus", startedAt: Date.now(), lock: true });
    this.host.say(this.hasApps() ? lines.FOCUS_ON : "专注模式开启！我先不打扰你～");
  }

  async stop() {
    const was = this.current;
    await this.replace(null);
    if (was?.kind === "focus") this.host.say(lines.FOCUS_OFF);
  }

  async unlockFor(minutes: number) {
    await invoke("focus_pause", { minutes });
    this.host.say(`解锁 ${minutes} 分钟～看完记得回来哦`);
  }

  /** "12:34" left, or null for open-ended focus. */
  remaining(now = Date.now()): string | null {
    const end = this.current?.endsAt;
    if (!end) return null;
    return clock(Math.max(0, Math.ceil((end - now) / 1000)));
  }

  /** How long this session has run, "12:34". */
  elapsed(now = Date.now()): string {
    return clock(Math.max(0, Math.floor((now - (this.current?.startedAt ?? now)) / 1000)));
  }

  /** How much of a timed session is done, 0…1 (0 for open-ended focus). */
  progress(now = Date.now()): number {
    const s = this.current;
    if (!s?.endsAt) return 0;
    return Math.min(1, Math.max(0, (now - s.startedAt) / (s.endsAt - s.startedAt)));
  }

  private hasApps() {
    return this.host.settings().focusApps.length > 0;
  }

  private async replace(next: Session | null) {
    const was = this.current;
    if (was?.lock && !next?.lock) await this.lockApps(false);
    if (next?.lock && !was?.lock) await this.lockApps(true);
    await this.set(next);
  }

  private async set(next: Session | null) {
    this.current = next;
    await (await store()).set(keys.session, next);
    if (next) this.startClock();
    else this.stopClock();
    this.host.changed(next);
  }

  private startClock() {
    if (!this.timer) this.timer = window.setInterval(() => void this.second(), 1000);
  }

  private stopClock() {
    window.clearInterval(this.timer);
    this.timer = 0;
  }

  private async second() {
    const s = this.current;
    if (!s) return this.stopClock();
    if (!s.endsAt || Date.now() < s.endsAt) return this.host.changed(s);
    const { breakMin, focusMin } = this.host.settings().pomodoro;
    if (s.kind === "pomodoro") {
      await this.replace({ kind: "break", startedAt: Date.now(), endsAt: Date.now() + breakMin * MIN, lock: false });
      this.host.celebrate();
      this.host.say(lines.pomodoroDone(breakMin));
    } else {
      await this.replace(null);
      this.host.say(lines.BREAK_DONE, { label: `再来 ${focusMin} 分钟 →`, run: () => void this.startPomodoro(focusMin) });
    }
  }

  private async lockApps(on: boolean, runShortcuts = true) {
    if (!inTauri) return;
    const settings = this.host.settings();
    await invoke(on ? "focus_block" : "focus_unblock", { apps: settings.focusApps });
    const shortcut = on ? settings.dndOn : settings.dndOff;
    if (!runShortcuts || !shortcut) return;
    try {
      await invoke("run_shortcut", { name: shortcut });
    } catch (e) {
      log("focus: shortcut failed:", errorText(e));
      if (!this.dndWarned) {
        this.dndWarned = true;
        this.host.say("勿扰模式的快捷指令没运行成功，去设置里检查一下名字？");
      }
    }
  }
}

/** Water / stretch / eyes every N minutes of actual computer time; never during focus or at night. */
export class Health {
  private last = Date.now();
  private turn = 0;

  constructor(private host: { settings(): Settings; quiet(): boolean; nudge(text: string): void }) {}

  /** After a break the clock starts over. */
  reset() {
    this.last = Date.now();
  }

  async check(now = Date.now()) {
    const { enabled, everyMin } = this.host.settings().health;
    const hour = new Date(now).getHours();
    if (!enabled || this.host.quiet() || hour < 7) {
      this.last = Math.max(this.last, now - everyMin * MIN + 5 * MIN);
      return;
    }
    // Away from the keyboard for a while counts as a break.
    const idle = inTauri ? await invoke<number>("idle_seconds").catch(() => 0) : 0;
    if (idle > 5 * 60) {
      this.last = now;
      return;
    }
    if (now - this.last < everyMin * MIN) return;
    this.last = now;
    this.host.nudge(lines.HEALTH_LINES[this.turn++ % lines.HEALTH_LINES.length]);
  }
}
