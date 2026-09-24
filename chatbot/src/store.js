import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { log } from "./logger.js";

/**
 * Luu trang thai nho vao data/state.json:
 * - processed: id tin nhan da xu ly (chong xu ly trung khi webhook gui lai)
 * - botMessages: id tin nhan do bot gui (de phan biet voi nhan vien that)
 * - lastHandled: { conversationId: messageId cuoi cung bot da tra loi }
 * - convUpdatedAt: { conversationId: updated_at } dung cho che do poll
 */
const MAX_IDS = 20000; // tang de nho lau hon tin cua bot (phan biet voi tin tu dong cua Facebook)

class Store {
  constructor() {
    fs.mkdirSync(config.dataDir, { recursive: true });
    this.file = path.join(config.dataDir, "state.json");
    this.state = { processed: [], botMessages: [], lastHandled: {}, convUpdatedAt: {}, stats: {}, recent: {} };
    this._load();
    this._processed = new Set(this.state.processed);
    this._bot = new Set(this.state.botMessages);
    this._timer = null;
  }

  _load() {
    try {
      if (fs.existsSync(this.file)) {
        Object.assign(this.state, JSON.parse(fs.readFileSync(this.file, "utf8")));
      }
    } catch (e) {
      log.warn("Khong doc duoc state.json, bat dau moi:", e.message);
    }
  }

  _save() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this.state.processed = [...this._processed].slice(-MAX_IDS);
      this.state.botMessages = [...this._bot].slice(-MAX_IDS);
      try {
        fs.writeFileSync(this.file, JSON.stringify(this.state));
      } catch (e) {
        log.warn("Khong ghi duoc state.json:", e.message);
      }
    }, 500);
  }

  isProcessed(id) {
    return this._processed.has(id);
  }
  markProcessed(id) {
    if (!id) return;
    this._processed.add(id);
    if (this._processed.size > MAX_IDS * 1.2) {
      this._processed = new Set([...this._processed].slice(-MAX_IDS));
    }
    this._save();
  }

  isBotMessage(id) {
    return !!id && this._bot.has(id);
  }
  markBotMessage(id) {
    if (!id) return;
    this._bot.add(id);
    this._save();
  }

  getLastHandled(convId) {
    return this.state.lastHandled[convId];
  }
  setLastHandled(convId, messageId) {
    this.state.lastHandled[convId] = messageId;
    this._save();
  }

  /** Thong ke theo page theo ngay (gio VN): replies, handoffs, skippedStaff */
  bumpStat(pageId, key) {
    const day = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
    const s = (this.state.stats ||= {});
    const p = (s[String(pageId)] ||= {});
    const d = (p[day] ||= {});
    d[key] = (d[key] || 0) + 1;
    p.lastActivity = Date.now();
    const days = Object.keys(p).filter((k) => k !== "lastActivity").sort();
    while (days.length > 30) delete p[days.shift()];
    this._save();
  }
  getStats(pageId) {
    return (this.state.stats || {})[String(pageId)] || {};
  }
  /** 30 cau tra loi gan nhat cua page de xem trong app */
  recordReply(pageId, entry) {
    const r = (this.state.recent ||= {});
    const list = (r[String(pageId)] ||= []);
    list.push({ at: Date.now(), ...entry });
    if (list.length > 30) list.splice(0, list.length - 30);
    this._save();
  }
  getRecent(pageId) {
    return ((this.state.recent || {})[String(pageId)] || []).slice().reverse();
  }

  /** Gui hang loat: nho khach nao da nhan luc nao (tranh gui lap) */
  getBroadcastSent(convId) {
    return (this.state.broadcast || {})[convId] || 0;
  }
  setBroadcastSent(convId) {
    (this.state.broadcast ||= {})[convId] = Date.now();
    this._save();
  }

  /**
   * Bam khach chua chot (sales agent): moi hoi thoai nho da bam may lan, lan cuoi luc nao, giai doan gi,
   * va co bi dung han khong (khach tu choi / nhan vien tat).
   * followupDaily: { "<pageId>|<ngay VN>": so tin da bam } de chan tran tin trong 1 ngay.
   */
  getFollowup(convId) {
    return (this.state.followup || {})[convId] || { touches: 0, lastAt: 0, stage: "", stopped: false };
  }

  bumpFollowup(pageId, convId, stage) {
    const f = (this.state.followup ||= {});
    const cur = f[convId] || { touches: 0, lastAt: 0, stage: "", stopped: false };
    f[convId] = { ...cur, touches: (cur.touches || 0) + 1, lastAt: Date.now(), stage: stage || cur.stage };
    const d = (this.state.followupDaily ||= {});
    const key = `${pageId}|${this._today()}`;
    d[key] = (d[key] || 0) + 1;
    // Chi giu 2000 hoi thoai + 30 ngay gan nhat
    const keys = Object.keys(f);
    if (keys.length > 2000) for (const k of keys.slice(0, keys.length - 2000)) delete f[k];
    const dk = Object.keys(d).sort();
    if (dk.length > 200) for (const k of dk.slice(0, dk.length - 200)) delete d[k];
    this._save();
    return f[convId];
  }

  /** Dung bam hoi thoai nay han (khach tu choi, hoac nhan vien bam nut dung) */
  stopFollowup(convId, stopped = true) {
    const f = (this.state.followup ||= {});
    f[convId] = { ...(f[convId] || { touches: 0, lastAt: 0, stage: "" }), stopped: !!stopped };
    this._save();
    return f[convId];
  }

  countFollowupToday(pageId) {
    return (this.state.followupDaily || {})[`${pageId}|${this._today()}`] || 0;
  }

  _today() {
    return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  }

  getConvUpdatedAt(convId) {
    return this.state.convUpdatedAt[convId];
  }

  /**
   * Khach khong the nhan tin (Facebook tra "(#551) Nguoi nay hien khong co mat"): nho thoi diem loi
   * de KHONG soan lai tra loi moi phut (moi lan ton ~7k token ma van khong gui duoc). Chi thu lai khi
   * khach nhan tin MOI sau thoi diem do.
   */
  /** Lan cuoi bot con song (luoi an toan ghi moi phut) - de khi bat lai biet bot vua tat trong bao lau */
  getLastAlive() {
    return this.state.lastAlive || 0;
  }
  setLastAlive(ts = Date.now()) {
    this.state.lastAlive = ts;
    this._save();
  }

  getUnreachableAt(convId) {
    return (this.state.unreachable || {})[convId] || 0;
  }
  setUnreachableAt(convId, ts = Date.now()) {
    const u = (this.state.unreachable ||= {});
    u[convId] = ts;
    // Chi giu 500 hoi thoai gan nhat
    const keys = Object.keys(u);
    if (keys.length > 500) for (const k of keys.slice(0, keys.length - 500)) delete u[k];
    this._save();
  }
  setConvUpdatedAt(convId, ts) {
    this.state.convUpdatedAt[convId] = ts;
    this._save();
  }
}

export const store = new Store();
