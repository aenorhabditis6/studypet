const WEEKDAY = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const MIN = 60_000;
const HOUR = 60 * MIN;

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Calendar days from `now` to `ts` (0 = today, 1 = tomorrow, -1 = yesterday). */
export function dayOffset(ts: number, now = Date.now()): number {
  return Math.round((startOfDay(ts) - startOfDay(now)) / (24 * HOUR));
}

export function hm(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 今天 / 明天 / 后天 / 周三 / 10月3日 */
export function dayWord(ts: number, now = Date.now()): string {
  const off = dayOffset(ts, now);
  if (off === 0) return "今天";
  if (off === 1) return "明天";
  if (off === 2) return "后天";
  if (off === -1) return "昨天";
  const d = new Date(ts);
  if (off > 0 && off < 7) return WEEKDAY[d.getDay()];
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** "明天 23:59" */
export function dueText(ts: number, now = Date.now()): string {
  return `${dayWord(ts, now)} ${hm(ts)}`;
}

/**
 * "还有 45 分钟" / "还有 2 小时 40 分钟" / "还有 20 小时" / "还有 2 天" / "已经过了 2 小时".
 * Always rounds down: better to under-promise how much time is left before a deadline.
 */
export function relative(ts: number, now = Date.now()): string {
  const diff = ts - now;
  const abs = Math.abs(diff);
  let amount: string;
  if (abs < HOUR) {
    amount = `${Math.max(1, Math.floor(abs / MIN))} 分钟`;
  } else if (abs < 3 * HOUR) {
    const h = Math.floor(abs / HOUR);
    const m = Math.floor((abs - h * HOUR) / MIN);
    amount = m ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
  } else if (abs < 48 * HOUR) {
    amount = `${Math.floor(abs / HOUR)} 小时`;
  } else {
    amount = `${Math.floor(abs / (24 * HOUR))} 天`;
  }
  return diff >= 0 ? `还有 ${amount}` : `已经过了 ${amount}`;
}

/**
 * Calendar locations are often a meeting link plus its password
 * ("https://…zoom.us/j/…?pwd=… Password: 123"). Split out the link; drop a trailing
 * password line, since the link already carries it.
 */
export function splitLocation(location?: string): { text?: string; url?: string } {
  if (!location) return {};
  const link = location.match(/https?:\/\/[^\s<>"]+/);
  if (!link) return { text: location };
  let rest = location
    .replace(link[0], " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s,;:：·|–—-]+|[\s,;:：·|–—-]+$/g, "");
  if (/^(password|passcode|pwd|meeting id|密码)\s*[:：]/i.test(rest)) rest = "";
  if (/^(zoom|online|remote|virtual|线上|在线)( meeting)?$/i.test(rest)) rest = "";
  return { text: rest || undefined, url: link[0] };
}

export function meetingName(url: string): string {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return "链接";
  }
  if (host.includes("zoom")) return "Zoom";
  if (host.includes("meet.google")) return "Google Meet";
  if (host.includes("teams")) return "Teams";
  return "在线会议";
}

/** "今天 · 9月26日 周六" */
export function dayHeading(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const date = `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAY[d.getDay()]}`;
  const off = dayOffset(ts, now);
  return off >= 0 && off <= 2 ? `${dayWord(ts, now)} · ${date}` : date;
}

/** "刚刚" / "5 分钟前" / "3 小时前" */
export function ago(ts: number, now = Date.now()): string {
  const diff = now - ts;
  if (diff < MIN) return "刚刚";
  if (diff < HOUR) return `${Math.round(diff / MIN)} 分钟前`;
  if (diff < 24 * HOUR) return `${Math.round(diff / HOUR)} 小时前`;
  return `${Math.round(diff / (24 * HOUR))} 天前`;
}
