import { orderSync } from "./orders.js";
import { settings } from "./settings.js";
import { store } from "./store.js";
import { log } from "./logger.js";
import { sortChrono, parseTs } from "./util.js";

/**
 * ═══════════ BOT LÊN ĐƠN (độc lập với bot tư vấn) ═══════════
 *
 * Bot tư vấn chỉ nói chuyện với khách. Bot này theo dõi các hội thoại bot đã trả lời, GỘP thông tin khách nhắn rải
 * rác nhiều lần (SĐT tin trước, địa chỉ tin sau, size tin giữa) và chỉ ghi đơn lên POS khi mọi thứ đã XÁC ĐỊNH:
 *  - SĐT khách tự gõ trong hội thoại, mẫu / màu / size khớp đúng biến thể POS,
 *  - địa chỉ khớp ĐỦ tỉnh / huyện / xã của Pancake bằng tên khách gõ (không dò gần đúng) + có số nhà / thôn xóm.
 * Ba trạng thái, không trạng thái nào bị bỏ quên:
 *  PENDING — còn thiếu thông tin, chờ khách nhắn nốt; im lặng quá `waitMinutes` ⇒ sang REVIEW.
 *  REVIEW  — đủ ý mua nhưng không chắc (địa chỉ không khớp đủ cấp, màu/size không có trên POS...) ⇒ nhân viên sửa & duyệt.
 *  DONE    — đã ghi đơn nháp lên POS (cập nhật lại nếu khách nhắn thêm).
 * Tiết kiệm AI: chỉ gọi AI trích đơn khi bộ đọc miễn phí (customerFacts) thấy đủ SĐT + địa chỉ, hoặc thông tin vừa đổi.
 */
const SWEEP_MS = 5 * 60 * 1000;
const DEBOUNCE_MS = 60 * 1000;

export class OrderBot {
  constructor(bot) {
    this.bot = bot;
    this.timers = new Map();
    this.running = new Set();
  }

  get items() {
    return (store.state.orderBot ||= {});
  }

  _save() {
    store._save();
  }

  enabledFor(pageId) {
    const eff = settings.effective(pageId);
    // Page dang "chi log" (dry run) thi bot tu van khong gui gi cho khach -> cung khong duoc ghi don that len POS
    return settings.orderBot().enabled && orderSync.enabled && !!eff.orderSync && !eff.dryRun;
  }

  /** Bot tu van vua xu ly xong mot luot cua hoi thoai: ghi nhan, va hen kiem tra neu thong tin moi du */
  notify(pageId, conversationId, messages, customerName = "") {
    if (!this.enabledFor(pageId)) return;
    const f = this.bot.customerFacts(pageId, messages);
    if (!f.phone && !f.address) return; // chua co dau hieu mua -> khong theo doi
    const key = String(conversationId);
    const cur = this.items[key] || { pageId: String(pageId), conversationId: key, status: "PENDING", firstSeen: Date.now(), reasons: [] };
    const dauVet = JSON.stringify([f.phone, f.address, f.size, f.color]);
    const khachCuoi = [...(messages || [])].reverse().find((m) => !this.bot.isFromPage(m, pageId));
    cur.customerName = customerName || cur.customerName || "";
    cur.lastCustomerAt = khachCuoi ? parseTs(khachCuoi.inserted_at) : Date.now();
    cur.facts = { phone: f.phone, address: f.address, size: f.size, color: f.color };
    const doi = cur.fingerprint !== dauVet;
    cur.fingerprint = dauVet;
    // Da len don / dang cho duyet ma khach nhan them thong tin moi -> kiem lai (cap nhat don / co the het loi)
    if (cur.status === "DISMISSED" && !doi) return;
    if (doi && cur.status !== "PENDING") cur.status = "PENDING";
    this.items[key] = cur;
    this._save();
    if (doi && f.phone && f.address) this.schedule(key, DEBOUNCE_MS);
  }

  schedule(key, ms) {
    clearTimeout(this.timers.get(key));
    this.timers.set(key, setTimeout(() => this.check(key).catch((e) => log.warn(`[orderbot] ${key}: ${e.message}`)), ms));
  }

  async history(pageId, conversationId) {
    const client = this.bot.getClient(pageId);
    if (!client) throw new Error("Không có page " + pageId);
    const data = await client.getMessages(conversationId);
    let messages = sortChrono(data.messages);
    try {
      messages = await this.bot.fetchMoreHistory(client, conversationId, messages, 60);
    } catch {}
    const text = messages.slice(-60).map((m) => `${this.bot.isFromPage(m, pageId) ? "SHOP" : "KHÁCH"}: ${this.bot.messageText(m)}`).join("\n");
    return { messages, text, name: data.conv_from?.name || "" };
  }

  /** Doc lai TOAN BO hoi thoai, gop thong tin, quyet dinh: len don / cho / can duyet */
  async check(key, { addressOverride = "", byStaff = false } = {}) {
    const it = this.items[key];
    if (!it || this.running.has(key)) return it;
    this.running.add(key);
    try {
      const { pageId, conversationId } = it;
      const { text, name } = await this.history(pageId, conversationId);
      const r = await orderSync.syncFromConversation({ pageId, pageName: this.bot.pageNames.get(pageId), conversationId, customerName: it.customerName || name, historyText: text, strict: true, addressOverride });
      it.lastCheckAt = Date.now();
      it.checks = (it.checks || 0) + 1;
      if (r.status === "created" || r.status === "updated") {
        it.status = "DONE";
        it.orderId = r.orderId;
        it.summary = r.summary;
        it.reasons = [];
        it.doneAt = Date.now();
        it.approvedByStaff = byStaff || undefined;
        store.bumpStat(pageId, "orderBotDone");
        store.recordReply(pageId, { conversationId, customerName: it.customerName || name, question: "(bot lên đơn)", reply: r.summary, handoff: false, dryRun: false, order: r.orderId });
        log.info(`[orderbot] ${key}: ${r.status} #${r.orderId}`);
      } else if (r.status === "review") {
        it.status = "REVIEW";
        it.reasons = r.reasons;
        it.draft = r.draft;
        store.bumpStat(pageId, "orderBotReview");
        log.warn(`[orderbot] ${key}: can duyet — ${r.reasons.join("; ")}`);
      } else {
        // skipped: chua du thong tin / khach da co don dang xu ly / SDT khong co trong hoi thoai...
        it.reasons = [r.reason || "chưa đủ thông tin"];
        if (/đã có đơn/.test(r.reason || "")) it.status = "DONE", (it.orderId = r.orderId), (it.summary = r.reason);
        else it.status = byStaff ? "REVIEW" : "PENDING";
      }
      this._save();
      return it;
    } finally {
      this.running.delete(key);
    }
  }

  /** Quet dinh ky: don cho qua han (khach im lang) -> kiem lan cuoi, con thieu thi sang can duyet */
  async sweep() {
    if (!settings.orderBot().enabled) return;
    const han = settings.orderBot().waitMinutes * 60 * 1000;
    const now = Date.now();
    for (const [key, it] of Object.entries(this.items)) {
      if (now - (it.lastCustomerAt || it.firstSeen || now) > 7 * 86400000 && it.status !== "REVIEW") {
        delete this.items[key]; // don xong / bo qua qua 7 ngay: don khoi so theo doi
        continue;
      }
      if (it.status !== "PENDING" || !it.facts?.phone) continue;
      if (now - (it.lastCustomerAt || it.firstSeen) < han) continue;
      if (!this.enabledFor(it.pageId)) continue;
      const r = await this.check(key).catch((e) => (log.warn(`[orderbot] ${key}: ${e.message}`), null));
      if (r && r.status === "PENDING") {
        r.status = "REVIEW";
        r.reasons = [`Khách im lặng hơn ${settings.orderBot().waitMinutes} phút, đơn còn thiếu: ${r.reasons.join("; ")}`];
        store.bumpStat(it.pageId, "orderBotReview");
      }
    }
    this._save();
  }

  start() {
    this.sweepTimer = setInterval(() => this.sweep().catch((e) => log.warn(`[orderbot] quet loi: ${e.message}`)), SWEEP_MS);
    this.sweepTimer.unref?.();
  }

  async approve(key, { address = "" } = {}) {
    const it = this.items[key];
    if (!it) throw new Error("Không tìm thấy hội thoại trong danh sách");
    it.status = "PENDING";
    return this.check(key, { addressOverride: String(address || "").trim(), byStaff: true });
  }

  dismiss(key) {
    const it = this.items[key];
    if (!it) throw new Error("Không tìm thấy hội thoại trong danh sách");
    it.status = "DISMISSED";
    it.dismissedAt = Date.now();
    this._save();
    return it;
  }

  list() {
    const rows = Object.entries(this.items).map(([key, it]) => ({ key, ...it, page: this.bot.pageNames.get(it.pageId) || it.pageId }));
    const today = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
    const ngay = (t) => (t ? new Date(t + 7 * 3600e3).toISOString().slice(0, 10) : "");
    return {
      settings: settings.orderBot(),
      counts: {
        pending: rows.filter((r) => r.status === "PENDING").length,
        review: rows.filter((r) => r.status === "REVIEW").length,
        doneToday: rows.filter((r) => r.status === "DONE" && ngay(r.doneAt) === today).length,
      },
      review: rows.filter((r) => r.status === "REVIEW").sort((a, b) => (b.lastCheckAt || 0) - (a.lastCheckAt || 0)),
      pending: rows.filter((r) => r.status === "PENDING").sort((a, b) => (b.lastCustomerAt || 0) - (a.lastCustomerAt || 0)).slice(0, 50),
      done: rows.filter((r) => r.status === "DONE").sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0)).slice(0, 30),
    };
  }
}
