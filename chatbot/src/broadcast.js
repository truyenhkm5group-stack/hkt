import { config } from "./config.js";
import { log } from "./logger.js";
import { store } from "./store.js";
import { settings } from "./settings.js";
import { parseTs, stripHtml, sleep } from "./util.js";

/**
 * Cham soc khach chua mua: quet hoi thoai theo so ngay, loc khach chua co SDT, gui tin mau hang loat theo dot.
 * - {name} trong tin = ten khach (tu cuoi cua ten hien thi)
 * - Ton trong: DRY_RUN chung, tag "BOT OFF", can_inbox cua Pancake, khong gui lai cho khach da nhan trong N ngay
 * - Moi page 1 job; co dung giua chung
 */
export class Broadcast {
  constructor() {
    this.jobs = new Map(); // pageId -> job
  }

  /** Quet hoi thoai inbox cua page trong `days` ngay */
  async scan(bot, pageId, { days = 7, from, to, hourFrom, hourTo, keyword = "", noPhoneOnly = true, customerLastOnly = false, maxPages = 120 } = {}) {
    const client = bot.getClient(pageId);
    if (!client) throw new Error("Khong co page " + pageId);
    const now = Date.now();
    // Khoang thoi gian: tu..den (ms) hoac N ngay gan nhat; neu nguoc thi tu dao lai
    let fromMs = from ? Number(from) : now - days * 24 * 3600e3;
    let toMs = to ? Number(to) : now + 60000;
    if (!Number.isFinite(fromMs)) fromMs = now - days * 24 * 3600e3;
    if (!Number.isFinite(toMs)) toMs = now + 60000;
    if (toMs < fromMs) [fromMs, toMs] = [toMs, fromMs];
    // Khung gio trong ngay (gio VN), vd 18 -> 23; qua dem (22 -> 6) cung duoc
    const hf = hourFrom === undefined || hourFrom === null || hourFrom === "" ? null : Number(hourFrom);
    const ht = hourTo === undefined || hourTo === null || hourTo === "" ? null : Number(hourTo);
    const inHour = (ms) => {
      if (hf === null && ht === null) return true;
      const h = Number(new Date(ms).toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", hour12: false }).slice(0, 2)) % 24;
      const a = hf ?? 0, b = ht ?? 24;
      return a <= b ? h >= a && h < b : h >= a || h < b;
    };
    const kw = String(keyword || "").trim().toLowerCase();
    const out = [];
    let last, scanned = 0, truncated = false;
    for (let i = 0; i < maxPages; i++) {
      const r = await client.getConversations({ type: "INBOX", order_by: "updated_at", last_conversation_id: last });
      const list = r.conversations || [];
      if (!list.length) break;
      scanned += list.length;
      let stop = false;
      for (const cv of list) {
        const at = parseTs(cv.updated_at);
        if (at < fromMs) {
          stop = true;
          break;
        }
        if (at > toMs) continue;
        if (!inHour(at)) continue;
        if (noPhoneOnly && cv.has_phone) continue;
        if (customerLastOnly && String(cv.last_sent_by?.id) === String(pageId)) continue;
        if (kw && !stripHtml(cv.snippet || "").toLowerCase().includes(kw) && !String(cv.from?.name || "").toLowerCase().includes(kw)) continue;
        const sentAt = store.getBroadcastSent(cv.id);
        out.push({
          id: cv.id,
          customer: cv.from?.name || "",
          updatedAt: cv.updated_at,
          snippet: stripHtml(cv.snippet || "").slice(0, 100),
          lastBy: String(cv.last_sent_by?.id) === String(pageId) ? "page" : "customer",
          paused: bot.isPaused(cv.tags, pageId),
          hasPhone: !!cv.has_phone,
          messageCount: cv.message_count,
          sentBefore: sentAt ? new Date(sentAt).toISOString() : null,
        });
      }
      last = list[list.length - 1].id;
      if (stop || list.length < 60) break;
      if (i === maxPages - 1) truncated = true;
    }
    return { total: out.length, conversations: out, days, from: new Date(fromMs).toISOString(), to: new Date(Math.min(toMs, now)).toISOString(), hourFrom: hf, hourTo: ht, keyword: kw, scanned, truncated, scannedAt: new Date().toISOString() };
  }

  status(pageId) {
    const j = this.jobs.get(String(pageId));
    if (!j) return { running: false };
    const { ids, text, perMinute, sent, failed, skipped, done, running, startedAt, current, errors, dryRun } = j;
    return { running, done, total: ids.length, sent, failed, skipped, current, perMinute, startedAt, dryRun, text: text.slice(0, 200), errors: errors.slice(-10) };
  }

  stop(pageId) {
    const j = this.jobs.get(String(pageId));
    if (j) j.running = false;
    return this.status(pageId);
  }

  /**
   * Bat dau gui hang loat (chay nen). ids = danh sach conversation id; text co {name}; perMinute = toc do.
   */
  start(bot, pageId, { ids, text, perMinute = 20, skipRecentDays = 14 }) {
    pageId = String(pageId);
    if (this.jobs.get(pageId)?.running) throw new Error("Page nay dang gui hang loat, hay dung truoc");
    if (!Array.isArray(ids) || !ids.length) throw new Error("Chua chon khach nao");
    if (!String(text || "").trim()) throw new Error("Chua nhap noi dung tin");
    const job = { ids: [...new Set(ids)], text: String(text), perMinute: Math.max(1, Math.min(60, Number(perMinute) || 20)), sent: 0, failed: 0, skipped: 0, done: 0, running: true, startedAt: Date.now(), current: "", errors: [], dryRun: settings.globalDryRun() };
    this.jobs.set(pageId, job);
    this._run(bot, pageId, job, skipRecentDays).catch((e) => log.error(`[${pageId}] Gui hang loat loi: ${e.message}`)).finally(() => (job.running = false));
    return this.status(pageId);
  }

  async _run(bot, pageId, job, skipRecentDays) {
    const client = bot.getClient(pageId);
    const gap = Math.round(60000 / job.perMinute);
    log.info(`[${pageId}] Bat dau gui hang loat cho ${job.ids.length} khach, ${job.perMinute} tin/phut${job.dryRun ? " (DRY RUN: chi log)" : ""}`);
    for (const cid of job.ids) {
      if (!job.running) break;
      job.current = cid;
      try {
        const sentAt = store.getBroadcastSent(cid);
        if (sentAt && Date.now() - sentAt < skipRecentDays * 24 * 3600e3) {
          job.skipped++;
          job.done++;
          continue;
        }
        const data = await client.getMessages(cid);
        if (data.can_inbox === false || data.is_banned) {
          job.skipped++;
          job.done++;
          job.errors.push(`${cid}: ngoai cua so nhan tin / bi chan`);
          continue;
        }
        const fullName = String(data.conv_from?.name || "").trim();
        const first = fullName.split(/\s+/).pop() || "";
        const text = job.text.replaceAll("{name}", first).replaceAll("{fullname}", fullName);
        if (job.dryRun) {
          log.info(`[${pageId}] (DRY RUN) gui hang loat -> ${fullName}: ${text.slice(0, 80)}`);
        } else {
          await bot.sendComposed(pageId, cid, text);
          store.setBroadcastSent(cid);
        }
        job.sent++;
        store.bumpStat(pageId, "broadcast");
      } catch (e) {
        job.failed++;
        job.errors.push(`${cid}: ${e.message}`);
        log.warn(`[${pageId}] Gui hang loat loi ${cid}: ${e.message}`);
      }
      job.done++;
      if (job.running && job.done < job.ids.length) await sleep(gap);
    }
    job.current = "";
    log.info(`[${pageId}] Gui hang loat xong: gui ${job.sent}, bo qua ${job.skipped}, loi ${job.failed}${job.running ? "" : " (da dung)"}`);
  }
}

export const broadcast = new Broadcast();
