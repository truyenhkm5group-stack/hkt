import crypto from "node:crypto";
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
const MAX_IDS = 20000;
const vnDay = (ms) => new Date(ms + 7 * 3600 * 1000).toISOString().slice(0, 10); // tang de nho lau hon tin cua bot (phan biet voi tin tu dong cua Facebook)

class Store {
  constructor() {
    fs.mkdirSync(config.dataDir, { recursive: true });
    this.file = path.join(config.dataDir, "state.json");
    this.state = { processed: [], botMessages: [], lastHandled: {}, convUpdatedAt: {}, stats: {}, recent: {} };
    this._load();
    this._startMeter();
    if (!this.state.hourlySince) this.state.hourlySince = Date.now();
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

  /**
   * THEO GIO (gio VN, ca shop) cho trang Tong quan: tin tra loi, chuyen nhan vien, token AI. Giu 72 gio.
   * Moc bat dau dem theo gio nam o hourlySince — gio truoc moc la CHUA BIET, khong phai 0.
   */
  _hour(ms = Date.now()) {
    if (!this.state.hourlySince) this.state.hourlySince = ms;
    const key = new Date(ms + 7 * 3600 * 1000).toISOString().slice(0, 13);
    const all = (this.state.hourly ||= {});
    if (!all[key]) {
      all[key] = {};
      const cutoff = new Date(ms + 7 * 3600 * 1000 - 72 * 3600e3).toISOString().slice(0, 13);
      for (const k of Object.keys(all)) if (k < cutoff) delete all[k];
    }
    return all[key];
  }
  getHourly() {
    return { since: this.state.hourlySince || null, hours: this.state.hourly || {} };
  }
  /** Thong ke theo page theo ngay (gio VN): replies, handoffs, skippedStaff */
  bumpStat(pageId, key) {
    if (key === "replies" || key === "handoffs") {
      const h = this._hour();
      h[key] = (h[key] || 0) + 1;
    }
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
  /** Token AI theo page / ngay (gio VN) / model — giu 35 ngay. Xem aicost.js. */
  addAiUsage(pageId, model, t) {
    const day = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
    const all = (this.state.aiUsage ||= {});
    const p = (all[String(pageId)] ||= {});
    const d = (p[day] ||= {});
    const x = (d[String(model)] ||= { calls: 0, input: 0, cached: 0, output: 0 });
    x.calls += 1;
    x.input += t.input || 0;
    x.cached += t.cached || 0;
    x.output += t.output || 0;
    const hm = ((this._hour().ai ||= {})[String(model)] ||= { calls: 0, input: 0, cached: 0, output: 0 });
    hm.calls += 1;
    hm.input += t.input || 0;
    hm.cached += t.cached || 0;
    hm.output += t.output || 0;
    const days = Object.keys(p).sort();
    while (days.length > 35) delete p[days.shift()];
    this._save();
  }
  /**
   * MOC DO CHI PHI / SDT: tu luc nay moi dem SDT, nen phep chia chi dung ngay tu moc (truoc do chi co tien, khong co
   * SDT — chia 30 ngay tien cho 30 ngay don la chia hai tap khac nhau). Token cua NGAY BAT DAU ghi truoc moc duoc chup
   * lai (baseline) de tru ra, nen ngay dau cung khop dung khung gio.
   */
  _startMeter() {
    if (this.state.meter?.since) return;
    const since = Date.now();
    const day = vnDay(since);
    const baseline = {};
    for (const [page, byDay] of Object.entries(this.state.aiUsage || {})) {
      if (byDay[day]) baseline[page] = JSON.parse(JSON.stringify(byDay[day]));
    }
    this.state.meter = { since, day, baseline };
    this._save();
  }
  getMeter() {
    return this.state.meter;
  }
  /**
   * SDT khach de lai trong hoi thoai bot phu trach: moi so dem MOT lan, o ngay khach go no (gio VN). Chi luu BAM cua
   * so (khong luu so that). Tin go truoc moc do khong dem — do la SDT cua ky truoc, khong phai ket qua cua tien nay.
   */
  addPhone(pageId, phone, atMs) {
    if (!phone || !Number.isFinite(atMs) || atMs < (this.state.meter?.since || 0)) return false;
    const key = crypto.createHash("sha256").update(phone).digest("hex").slice(0, 16);
    const all = (this.state.phones ||= {});
    if (all[key]) return false;
    all[key] = { p: String(pageId), d: vnDay(atMs) };
    const cutoff = vnDay(Date.now() - 35 * 86400000);
    for (const [k, v] of Object.entries(all)) if (v.d < cutoff) delete all[k];
    this._save();
    return true;
  }
  /** So SDT moi theo page trong cac ngay cho truoc. */
  countPhones(days, pageId) {
    const set = new Set(days);
    let n = 0;
    for (const v of Object.values(this.state.phones || {})) if (set.has(v.d) && (pageId === undefined || v.p === String(pageId))) n++;
    return n;
  }
  /**
   * TIEN AI THEO TUNG HOI THOAI: moi luot goi AI trong luot xu ly mot hoi thoai ghi vao dung hoi thoai do, nen don nao
   * cung biet chinh hoi thoai cua no ton bao nhieu. Giu 35 ngay theo lan goi cuoi, toi da 30000 hoi thoai.
   */
  addConvAiUsage(pageId, conversationId, model, t) {
    if (!conversationId) return;
    const all = (this.state.convAi ||= {});
    const now = Date.now();
    const c = (all[String(conversationId)] ||= { p: String(pageId), first: now, last: now, m: {} });
    c.last = now;
    const x = (c.m[String(model)] ||= { calls: 0, input: 0, cached: 0, output: 0 });
    x.calls += 1;
    x.input += t.input || 0;
    x.cached += t.cached || 0;
    x.output += t.output || 0;
    const keys = Object.keys(all);
    if (keys.length > 30000 || Math.random() < 0.01) {
      const cutoff = now - 35 * 86400000;
      for (const k of keys) if (all[k].last < cutoff) delete all[k];
      const left = Object.keys(all).sort((a, b) => all[a].last - all[b].last);
      while (left.length > 30000) delete all[left.shift()];
    }
    this._save();
  }
  getConvAi(conversationId) {
    return (this.state.convAi || {})[String(conversationId)] || null;
  }
  /**
   * DON BOT GHI VAO POS, moi ma don dem MOT lan (tao moi hay cap nhat don nhap deu la mot don), theo lan ghi dau.
   * Bo dem "orders" cu cong ca lan cap nhat nen mot don co the dem 2-3 lan. Chi dem tu moc do.
   */
  addBotOrder(pageId, orderId, conversationId) {
    if (!orderId) return false;
    const all = (this.state.botOrders ||= {});
    const key = String(orderId);
    if (all[key]) return false;
    const now = Date.now();
    if (now < (this.state.meter?.since || 0)) return false;
    all[key] = { p: String(pageId), c: conversationId ? String(conversationId) : "", t: now, d: vnDay(now) };
    const cutoff = vnDay(now - 35 * 86400000);
    for (const [k, v] of Object.entries(all)) if (v.d < cutoff) delete all[k];
    this._save();
    return true;
  }
  /**
   * HO SO DON THEO HOI THOAI: lan dau thay khach da cho DU thong tin (SDT + dia chi + so do/size + mau) thi ghi lai,
   * de cac luot sau khong phai doc lai tu cua so ~30 tin gan nhat (tin cu troi mat -> bot hoi lai thu da biet).
   * Su co 02/10/2026 (Bui Phuong Vy, Linh Tay Luxury). Giu 35 ngay.
   */
  /**
   * BAN CHEP GHI AM theo id tin: chep mot lan, moi luot sau (va sau khi khoi dong lai) doc lai tu day — chep lai la
   * ton tien va co the ra chu khac, lam khach "doi loi" giua hai luot. Giu 35 ngay.
   */
  getVoiceText(messageId) {
    const v = (this.state.voiceText || {})[String(messageId)];
    return v ? v.text : null;
  }
  setVoiceText(messageId, text) {
    if (!messageId) return;
    const all = (this.state.voiceText ||= {});
    all[String(messageId)] = { text: String(text || ""), t: Date.now() };
    const cutoff = Date.now() - 35 * 86400000;
    for (const [k, v] of Object.entries(all)) if ((v.t || 0) < cutoff) delete all[k];
    this._save();
  }
  getOrderInfo(conversationId) {
    return (this.state.orderInfo || {})[String(conversationId)] || null;
  }
  setOrderInfo(conversationId, info) {
    if (!conversationId) return;
    const all = (this.state.orderInfo ||= {});
    all[String(conversationId)] = { ...info, t: Date.now() };
    const cutoff = Date.now() - 35 * 86400000;
    for (const [k, v] of Object.entries(all)) if ((v.t || 0) < cutoff) delete all[k];
    this._save();
  }
  countOrders(days, pageId) {
    const set = new Set(days);
    let n = 0;
    for (const v of Object.values(this.state.botOrders || {})) if (set.has(v.d) && (pageId === undefined || v.p === String(pageId))) n++;
    return n;
  }
  recentBotOrders(limit = 30) {
    return Object.entries(this.state.botOrders || {})
      .map(([id, v]) => ({ id, ...v }))
      .sort((a, b) => b.t - a.t)
      .slice(0, limit);
  }
  getAiUsage(pageId) {
    return (this.state.aiUsage || {})[String(pageId)] || {};
  }
  getAllAiUsage() {
    return this.state.aiUsage || {};
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
