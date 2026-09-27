// What the pet says. Tone rules from the plan: gentle, never guilt-tripping, and when
// something is missed, offer a way forward instead of a scolding.
import type { Outlook } from "./agenda";
import { dueText, hm, meetingName, relative, splitLocation } from "./format";
import type { Item, Notice } from "./types";

const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];

let petName = "";

/** The pet talks about itself by name ("奶蛋陪你"), which is more fun than "我". */
export function setPetName(name: string) {
  petName = name.trim();
}

/** The pet's name when it's a real, short one; otherwise "我". */
const me = () => (petName && [...petName].length <= 10 && petName !== "我的宠物" ? petName : "我");

/**
 * Chinese typography for sentences built from English titles and times: a space between
 * CJK and Latin/digits, none around full-width punctuation.
 */
export function tidy(s: string): string {
  return s
    .replace(/([㐀-鿿])([A-Za-z0-9])/g, "$1 $2")
    .replace(/([A-Za-z0-9])([㐀-鿿])/g, "$1 $2")
    .replace(/\s*([（），。！？：；、～…「」])\s*/g, "$1")
    .replace(/ {2,}/g, " ")
    .trim();
}

export const label = (i: Item) => (i.courseShort ? `${i.title}（${i.courseShort}）` : i.title);

export function hello(now = new Date()): string {
  const h = now.getHours();
  if (h < 5) return "这么晚还没睡呀";
  if (h < 11) return "早上好";
  if (h < 14) return "中午好";
  if (h < 18) return "下午好";
  return "晚上好";
}

export function greeting(o: Outlook, now = Date.now()): string {
  return tidy(`${hello(new Date(now))}！${summary(o, now)}`);
}

/** One-line state of things, used for greetings, clicks and the panel header. */
export function summary(o: Outlook, now = Date.now()): string {
  const next = o.next;
  switch (o.level) {
    case "empty":
      return tidy(`右键${me()}就能连上 Canvas，之后${me()}来帮你盯 due～`);
    case "calm":
      return tidy(
        next
          ? `最近两天没有 due～下一个是${dueText(next.start, now)}的 ${label(next)}`
          : "最近没有 due，好好休息一下吧～",
      );
    case "heads-up":
      return tidy(`${label(next!)} ${dueText(next!.start, now)}截止，可以开始准备啦`);
    case "soon":
      return tidy(
        o.within24h.length > 1
          ? `24 小时内有 ${o.within24h.length} 个 due，最近的是 ${label(next!)}（${dueText(next!.start, now)}）`
          : `${label(next!)} ${dueText(next!.start, now)}截止，要不要先做 25 分钟？${me()}陪你`,
      );
    case "urgent":
      return tidy(`${label(next!)} ${relative(next!.start, now)}就截止啦！冲呀，${me()}在旁边给你打气`);
    case "overdue":
      return tidy(`${label(o.overdue[0])} 好像过了截止时间……没关系，看看还能不能补交？${me()}陪你想办法`);
  }
}

/** Crossing a reminder threshold (hours before the deadline). */
export function remind(item: Item, thresholdH: number, now = Date.now()): string {
  const when = dueText(item.start, now);
  if (thresholdH <= 3) {
    return tidy(
      pick([
        `${label(item)} ${relative(item.start, now)}就截止了！最后冲刺，${me()}陪着你～`,
        `提醒一下：${label(item)} ${when}截止，${relative(item.start, now)}`,
      ]),
    );
  }
  if (thresholdH <= 24) {
    return tidy(pick([`${label(item)} ${when}截止～今天先做一小部分？`, `${when}之前要交 ${label(item)}，现在开始正好不慌`]));
  }
  return tidy(`${label(item)} ${when}截止，还有几天，可以慢慢开始啦`);
}

export function classSoon(ev: Item, minutes: number): string {
  const place = splitLocation(ev.location);
  const where = place.text ?? (place.url ? meetingName(place.url) : "");
  return tidy(`${minutes} 分钟后是 ${ev.courseShort ?? ev.title}${where ? `（${where}）` : ""}，该准备出发啦～`);
}

export function nightNudge(ev: Item, now = Date.now()): string {
  return tidy(`已经 ${hm(now)} 啦，明天 ${hm(ev.start)} 还有 ${ev.courseShort ?? ev.title}，早点睡吧～`);
}

export function celebrate(item?: Item): string {
  return tidy(
    pick([
      "交啦！你超棒的 🎉",
      item ? `${item.title} 搞定！奖励自己休息一下吧～` : "又完成一个！奖励自己休息一下吧～",
      "又完成一个！给你转个圈圈～",
    ]),
  );
}

/** Default random lines (third click onwards). Editable in Settings. */
export const DEFAULT_QUIPS = [
  "天闹地麻，绷住怎么会是惩罚",
  "你闹的全麻走",
  "一个闹的重量取决于它麻在谁的心上",
  "是我闹你的方式麻了吗",
  "女孩闹你想闹的，麻了算我",
  "世界以痛吻我，我闹之以麻",
  "典孝绷急乐，串麻唐豪招",
  "众宾绷也",
  "无人绷还",
  "勿以乐小而绷之，为麻小而不闹",
  "天才在绷，疯子在耍",
  "事不关己，快快耍起",
  "如绷似串，闹死不麻",
  "微微一闹很麻麻",
  "来杯好麻闹一闹",
  "绷中间耍两边",
  "闹闹的就会麻麻的",
  "老绷不串，闹火相麻",
  "读书破万绷，下笔如有串",
  "闹闹者麻麻原则",
  "家闹万事麻",
  "此麻闹闹无绝期",
  "知绷明耍，苦乐参麻",
  "天才爱耍，庸人闹绷",
  "树欲静而心闹麻，子欲绷而身要耍",
  "世间以麻闹我，我报之以绷",
  "少不耍起，老来闹麻",
  "知世故而闹麻，懂人情而耍起",
];

/** Click #1 → the next deadline, click #2 → the one after. */
export function nextUp(item: Item, index: number, now = Date.now()): string {
  const lead = index === 0 ? "下一个作业" : "再下一个";
  return tidy(`${lead}：${label(item)}，${dueText(item.start, now)}截止（${relative(item.start, now)}）`);
}

export function nothingNext(index: number): string {
  return index === 0 ? "最近没有要交的作业～" : "后面暂时没有别的作业啦";
}

export function gradescopeConnected(count: number): string {
  return tidy(`Gradescope 连上啦！找到 ${count} 个作业，交没交${me()}都看得到～`);
}

export function submittedOnGradescope(item: Item): string {
  return tidy(pick([`看到你在 Gradescope 交了 ${item.title}！太棒啦 🎉`, `${item.title} 已提交！又清掉一个～`]));
}

export function edAnnouncement(n: Notice, more: number): string {
  return tidy(`📢 ${n.course} 在 Ed 发了公告：「${n.title}」${more > 0 ? `（还有 ${more} 条新的）` : ""}`);
}

export function welcome(name: string): string {
  return tidy(`嗨！我是${name}，以后就由${me()}陪着你啦～`);
}

export const HEALTH_LINES = ["喝口水吧～ 💧", "站起来走两步？伸个懒腰～", "看看远处 20 秒，让眼睛歇一歇～"];

export function pomodoroStart(minutes: number, locked: boolean): string {
  return tidy(`开始专注 ${minutes} 分钟！${locked ? "微信先帮你锁上啦，" : ""}${me()}在旁边陪你～`);
}

export function pomodoroDone(breakMin: number): string {
  return tidy(`专注完成！🍅 休息 ${breakMin} 分钟吧，起来喝口水走一走～`);
}

export const BREAK_DONE = "休息结束～要不要再来一个番茄钟？";
export function focusOn(locking: boolean): string {
  return tidy(locking ? `专注模式开启！微信先帮你锁上啦～（右键${me()}可以解锁）` : `专注模式开启！${me()}先不打扰你～`);
}
export const FOCUS_OFF = "专注模式结束，辛苦啦～";

export function blocked(app: string): string {
  return tidy(`专注中～${app} 先锁着哦`);
}

export function backFromMeeting(missed?: string): string {
  return tidy(missed ? `组会开完啦？刚才想跟你说：${missed}` : `组会开完啦？${me()}回来啦～`);
}
