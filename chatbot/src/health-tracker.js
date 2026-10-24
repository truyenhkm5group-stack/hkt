/**
 * Theo doi suc khoe bot nha de DAY len ERP (/api/internal/bot-health — lib/constants/home-bot-health.ts) — module THUAN: khong import gi
 * (nhu order-view.js / comment-inbox.js), bai kiem nap duoc ma khong chot DATA_DIR.
 *
 * Vi sao (24/10/2026): bot nha im 6 gio vi Gemini 403 «project has been denied access» ma khong ai biet — healthchecks.io chi biet tien
 * trinh con song, ERP khong thay. Bot KHONG phan loai loi (ERP phan loai bang classifyAiError, mot cho): chi gui ma HTTP + chu loi cua
 * nha cung cap (<= 160 ky tu, khong chu khach, khoa API bi che). Thua: cung ma loi trong 60 s chi gui mot lan; OK chi gui khi vua co loi.
 * Nhip 5′: so luot khach + so cau tra loi trong 5′ + moc tra loi cuoi.
 */
export const BEAT_EVERY_MS = 5 * 60_000;
export const ERROR_REPORT_GAP_MS = 60_000;

/** Che khoa API Google / chuoi dai giong bi mat trong chu loi truoc khi gui. */
export function scrubProviderMessage(message) {
  return String(message || "")
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "•••")
    .replace(/[A-Za-z0-9_-]{32,}/g, "•••")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

export function createHealthTracker({ now = Date.now } = {}) {
  let failing = false;
  let last = { status: null, at: 0 };
  let turns = 0;
  let replies = 0;
  let lastReplyAt = null;
  return {
    providerError(status, message) {
      const t = now();
      const s = Number(status) || 0;
      failing = true;
      if (last.status === s && t - last.at < ERROR_REPORT_GAP_MS) return null;
      last = { status: s, at: t };
      return { type: "PROVIDER_ERROR", status: Math.max(0, Math.min(999, s)), message: scrubProviderMessage(message) };
    },
    providerOk() {
      if (!failing) return null;
      failing = false;
      last = { status: null, at: 0 };
      return { type: "PROVIDER_OK" };
    },
    customerTurn() {
      turns += 1;
    },
    reply() {
      replies += 1;
      lastReplyAt = new Date(now()).toISOString();
    },
    beat() {
      const b = { type: "BEAT", replies5m: replies, customerTurns5m: turns, lastReplyAt };
      replies = 0;
      turns = 0;
      return b;
    },
  };
}
