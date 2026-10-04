import { orderSync, phonesInText, normalizePhone, hasStreetDetail, ORDER_STATUS_VI } from "./orders.js";
import { settings } from "./settings.js";
import { store } from "./store.js";
import { log } from "./logger.js";
import { sortChrono, parseTs } from "./util.js";
import { adBots } from "./adbots.js";
import { extractAdIds } from "./adpersona.js";
import { isOrderSummaryReply } from "./bot.js";

/**
 * ═══════════ BOT LÊN ĐƠN (độc lập với bot tư vấn) ═══════════
 *
 * Bot tư vấn chỉ nói chuyện với khách. Bot này theo dõi các hội thoại bot đã trả lời, GỘP thông tin khách nhắn rải
 * rác nhiều lần (SĐT tin trước, địa chỉ tin sau, size tin giữa) và chỉ ghi đơn lên POS khi mọi thứ đã XÁC ĐỊNH:
 *  - SĐT khách tự gõ trong hội thoại, mẫu / màu / size khớp đúng biến thể POS,
 *  - địa chỉ khớp ĐỦ tỉnh / huyện / xã của Pancake bằng tên khách gõ (không dò gần đúng); thiếu số nhà chỉ ghi chú.
 * Ba trạng thái, không trạng thái nào bị bỏ quên:
 *  PENDING — khách đã gõ SĐT: kiểm MỖI `checkEveryMinutes` phút (mặc định 30); đủ thông tin thì lên đơn + xác nhận và thôi
 *            kiểm; quá `maxChecks` lần (mặc định 3) vẫn chưa đủ ⇒ REVIEW và báo ERP (chủ shop 02/10/2026).
 *  REVIEW  — đủ ý mua nhưng không chắc (địa chỉ không khớp đủ cấp, màu/size không có trên POS...) ⇒ nhân viên sửa & duyệt.
 *  DONE    — đã ghi đơn nháp lên POS (cập nhật lại nếu khách nhắn thêm).
 * Tiết kiệm AI: chỉ gọi AI trích đơn khi bộ đọc miễn phí (customerFacts) thấy đủ SĐT + địa chỉ, hoặc thông tin vừa đổi.
 */
const SWEEP_MS = 5 * 60 * 1000;
// Mau chu luc chu shop chot cho tung page — ap MOT lan khi khoi dong neu page chua khai (sua lai trong cai dat page van
// duoc, khong bi de lai). Chu shop 02/10/2026: "mặc định page này chạy Q005" (Linh Tây Luxury CS1).
const PAGE_DEFAULT_PRODUCT_SEED = [{ page: "linh tay luxury cs1", code: "Q005" }];
const khongDau = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/\s+/g, " ").trim();

// Doi phien ban -> danh sach theo doi cu bi bo mot lan khi khoi dong (resetIfNeeded)
const ORDERBOT_VERSION = 2;

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

  /**
   * Bot tu van vua xu ly xong mot luot cua hoi thoai: khach DA GO SDT thi theo doi, hen lan kiem dau sau `checkEveryMinutes`
   * phut (`dueNow`: kiem ngay o luot quet toi — dung khi gieo lai danh sach sau reset). Khach nhan them thong tin moi sau
   * khi da sang "can duyet" / "bo qua" thi mo lai voi bo dem moi.
   */
  /**
   * Moc tin khach DONG Y ban chot don cua shop: tin DAU TIEN cua khach sau ban chot moi nhat la mot cau dong y ngan
   * ("Ok", "đúng rồi", "chốt"). Tin dau tien la sua thong tin / hoi them -> null (de nhip 30 phut lo).
   */
  confirmedSummaryAt(pageId, messages) {
    const ds = sortChrono(messages);
    let k = -1;
    for (let i = ds.length - 1; i >= 0; i--) {
      if (this.bot.isFromPage(ds[i], pageId) && isOrderSummaryReply(this.bot.messageText(ds[i]), false)) { k = i; break; }
    }
    if (k < 0) return null;
    const dau = ds.slice(k + 1).find((m) => !this.bot.isFromPage(m, pageId));
    if (!dau) return null;
    const t = String(this.bot.messageText(dau) || "").trim();
    if (t.length > 40 || !/^(ok|oke|okie|okay|ô kê|ừ|uh|uk|ukm|vâng|đúng|chuẩn|chốt|yes|ok em|được rồi)(?![a-zà-ỹ])/i.test(t)) return null;
    return parseTs(dau.inserted_at) || Date.now();
  }

  notify(pageId, conversationId, messages, customerName = "", adIds = [], { dueNow = false } = {}) {
    if (!this.enabledFor(pageId)) return;
    // Hoi thoai cua MAU TEST MOI (chua co tren POS): khong len don (chu shop: chi len don khi mau thang)
    if (adBots.testProductForConversation(conversationId, adIds)) return;
    const f = this.bot.customerFacts(pageId, messages);
    if (!f.phone) return; // chua co SDT -> chua theo doi
    const key = String(conversationId);
    const now = Date.now();
    const every = settings.orderBot().checkEveryMinutes * 60e3;
    const moi = !this.items[key];
    const cur = this.items[key] || { pageId: String(pageId), conversationId: key, status: "PENDING", firstSeen: now, reasons: [], rounds: 0, nextCheckAt: dueNow ? now : now + every };
    const dauVet = JSON.stringify([f.phone, f.address, f.size, f.color]);
    const khachCuoi = [...(messages || [])].reverse().find((m) => !this.bot.isFromPage(m, pageId));
    cur.customerName = customerName || cur.customerName || "";
    cur.lastCustomerAt = khachCuoi ? parseTs(khachCuoi.inserted_at) : now;
    cur.facts = { phone: f.phone, address: f.address, size: f.size, color: f.color };
    const doi = !moi && cur.fingerprint !== dauVet;
    cur.fingerprint = dauVet;
    // Khach vua DONG Y ban chot don cua bot ("Ok", "đúng rồi", "chốt") -> kiem ngay o luot quet toi, khong doi du 30 phut
    // (chu shop 02/10/2026, don Ha Dang: khach "Ok" ma don van "Mới, chưa có sản phẩm"). Moi tin dong y chi kich MOT lan.
    const dongY = this.confirmedSummaryAt(pageId, messages);
    if (dongY && cur.status === "PENDING" && dongY > (cur.agreedAt || 0)) {
      cur.agreedAt = dongY;
      cur.nextCheckAt = Math.min(cur.nextCheckAt || now, now);
    }
    // Truoc do bi giu lai vi khach xin huy, nay khach da dong y giu don -> kiem lai ngay o luot quet toi
    if (cur.status === "REVIEW" && /^khách xin hủy đơn/.test((cur.reasons || [])[0] || "") && !this.bot.cancelStage(pageId, messages)) {
      cur.status = "PENDING";
      cur.reasons = [];
      cur.reviewAt = undefined;
      cur.nextCheckAt = now;
    }
    if (doi && cur.status !== "PENDING") {
      // Da len don / can duyet / bo qua ma khach gui thong tin moi -> theo doi lai tu dau
      cur.status = "PENDING";
      cur.rounds = 0;
      cur.nextCheckAt = now + every;
      cur.reviewAt = undefined;
    }
    this.items[key] = cur;
    this._save();
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
  async check(key, { addressOverride = "", byStaff = false, defaultCode = "" } = {}) {
    const it = this.items[key];
    if (!it || this.running.has(key)) return it;
    this.running.add(key);
    try {
      const { pageId, conversationId } = it;
      const { messages, text, name } = await this.history(pageId, conversationId);
      // Nhan vien da tu len / xac nhan don cho khach nay -> xong, khong ton AI, khong bat ai duyet lai
      if (!byStaff && (await this.resolveIfStaffHandled(key, messages))) return it;
      // Khach dang XIN HUY (bot dang hoi ly do / giu don, hoac khach van huy): khong len / tu xac nhan don, de nhan vien
      // quyet (chu shop 02/10/2026). Khach dong y giu don o tin sau thi luot quet ke tiep len don binh thuong.
      if (!byStaff && this.bot.cancelStage(pageId, messages)) {
        if (it.status !== "REVIEW") it.reviewAt = Date.now();
        it.status = "REVIEW";
        it.reasons = ["khách xin hủy đơn — bot đang hỏi lý do / giữ đơn, chưa lên hay xác nhận đơn"];
        it.lastCheckAt = Date.now();
        this._save();
        return it;
      }
      if (defaultCode) it.defaultCode = defaultCode;
      const r = await orderSync.syncFromConversation({ pageId, pageName: this.bot.pageNames.get(pageId), conversationId, customerName: it.customerName || name, historyText: text, strict: true, addressOverride, defaultCode: it.defaultCode || "" });
      it.lastCheckAt = Date.now();
      it.checks = (it.checks || 0) + 1;
      if (r.status === "created" || r.status === "updated") {
        it.status = "DONE";
        it.orderId = r.orderId;
        it.summary = r.summary;
        it.reasons = [];
        it.doneAt = Date.now();
        it.approvedByStaff = byStaff || undefined;
        it.confirmNote = undefined;
        // TU XAC NHAN (chi khi chu shop bat): don nhan vien duyet tay thi nhan vien tu xac nhan tren Pancake
        if (settings.orderBot().autoConfirm && !byStaff) {
          it.confirmTried = true; // da thu xac nhan o lan nay -> luot quet khong kiem lai them mot lan (ton AI vo ich)
          const chan = this.dropSanctionedDiscount(r.confirmBlockers || [], r, pageId, messages);
          const kq = chan.length ? { ok: false, reason: chan.join("; ") } : await orderSync.confirmOrder(r.orderId, { conversationId, phone: r.phone, items: r.items }).catch((e) => ({ ok: false, reason: e.message }));
          if (kq.ok) {
            it.confirmedAt = Date.now();
            it.summary = r.summary.replace(/^(Tạo|Cập nhật) đơn nháp/, "Đã xác nhận đơn");
            store.bumpStat(pageId, "orderBotConfirmed");
            log.info(`[orderbot] ${key}: tu xac nhan #${r.orderId}`);
          } else {
            it.confirmNote = `Để đơn nháp, chưa tự xác nhận: ${kq.reason}`;
            // Khach con DON KHAC dang xu ly: mua them hay doi mau / trung don la viec NGUOI quyet -> can duyet + bao ERP,
            // khong nam im trong "da len don" (su co Binh Nguyen 02/10/2026)
            if (/khách đã có đơn #/.test(kq.reason || "")) {
              it.status = "REVIEW";
              it.reviewAt = Date.now();
              it.reasons = [`Đã lên đơn nháp #${r.orderId} nhưng ${kq.reason}: mua thêm thì xác nhận đơn #${r.orderId}, trùng / đổi mẫu thì huỷ một đơn`];
            }
          }
        }
        store.bumpStat(pageId, "orderBotDone");
        store.recordReply(pageId, { conversationId, customerName: it.customerName || name, question: "(bot lên đơn)", reply: r.summary, handoff: false, dryRun: false, order: r.orderId });
        log.info(`[orderbot] ${key}: ${r.status} #${r.orderId}`);
      } else if (r.status === "review") {
        if (it.status !== "REVIEW") it.reviewAt = Date.now();
        it.status = "REVIEW";
        it.reasons = r.reasons;
        it.draft = r.draft;
        store.bumpStat(pageId, "orderBotReview");
        log.warn(`[orderbot] ${key}: can duyet — ${r.reasons.join("; ")}`);
      } else {
        // skipped: chua du thong tin / khach da co don dang xu ly / SDT khong co trong hoi thoai...
        it.reasons = [r.reason || "chưa đủ thông tin"];
        if (r.draft) it.draft = r.draft;
        if (/đã có đơn/.test(r.reason || "")) it.status = "DONE", (it.orderId = r.orderId), (it.summary = r.reason);
        else it.status = byStaff ? "REVIEW" : "PENDING";
      }
      this._save();
      return it;
    } finally {
      this.running.delete(key);
    }
  }

  /**
   * Chan "giam gia vuot 30% gia POS" la de bot khong tu xac nhan gia tu che. Nhung mau dang XA KHO (Q002 gia cu 749K,
   * gia xa 299K — su co Nguyen Thi Triem #5710 04/10/2026) luon "giam" > 30% so voi gia POS, nen moi don xa kho deu ket
   * o don nhap. Bo chan nay CHI khi tong khach chot: (1) chinh shop da noi trong hoi thoai, VA (2) la gia hop le theo
   * bang gia cua page (cung bo kiem gia cua bot chat: so trong huong dan / POS, x so luong, + phi ship).
   */
  dropSanctionedDiscount(chan, r, pageId, messages) {
    const i = chan.findIndex((c) => /^giảm giá .* vượt 30% tiền hàng$/.test(c));
    if (i < 0 || !(r.agreed > 0)) return chan;
    const so = String(r.agreed);
    const shopNoi = (messages || []).some((m) => this.bot.isFromPage(m, pageId) && String(this.bot.messageText(m) || "").replace(/[.,\s]/g, "").includes(so));
    if (!shopNoi) return chan;
    let sys;
    try {
      sys = this.bot.buildSystemPrompt(pageId, { customerName: "Khách", type: "INBOX", saleActive: this.bot.saleActiveIn(pageId, messages) });
    } catch {
      return chan;
    }
    if (this.bot.findDisallowedPrices(`${r.agreed.toLocaleString("vi-VN")}đ`, sys).length) return chan;
    log.info(`[orderbot] ${pageId}: tong ${so}d la gia trong bang gia cua page (xa kho / combo) -> khong chan vi giam > 30%`);
    return chan.filter((_, j) => j !== i);
  }

  /** Cac SDT khach tu go trong hoi thoai (khong lay so cua shop) */
  customerPhones(pageId, messages) {
    return [...new Set((messages || []).filter((m) => !this.bot.isFromPage(m, pageId)).flatMap((m) => phonesInText(this.bot.messageText(m))))];
  }

  /**
   * Khach da co don do NHAN VIEN len / xac nhan (orderSync.staffHandledOrder) -> chuyen sang "da len don", ghi ro don nao.
   * Tra ve true neu da xu ly. Loi POS thi coi nhu chua biet (false), khong doan.
   */
  async resolveIfStaffHandled(key, messages) {
    const it = this.items[key];
    if (!it) return false;
    const phones = this.customerPhones(it.pageId, messages);
    if (!phones.length) return false;
    const don = await orderSync.staffHandledOrder(it.conversationId, phones, it.firstSeen).catch(() => null);
    if (!don) return false;
    if (String(don.id) === String(it.orderId)) {
      // Chinh don bot da len (nhan vien / bot da xac nhan) -> van la "da len don", khong ghi nham la nhan vien len
      it.status = "DONE";
      it.reasons = [];
      this._save();
      return true;
    }
    it.status = "DONE";
    it.orderId = don.id;
    it.doneAt = Date.now();
    it.byStaffOrder = true;
    it.summary = `Nhân viên đã lên đơn #${don.id} (${ORDER_STATUS_VI[Number(don.status)] || don.status_name || don.status}) — bot không làm gì thêm`;
    it.reasons = [];
    this._save();
    log.info(`[orderbot] ${key}: nhan vien da len don #${don.id}`);
    return true;
  }

  /**
   * MOT LAN KIEM THEO NHIP: dem lan kiem; du thi xong (check da len don + xac nhan); chua du thi hen lan sau, toi
   * `maxChecks` lan thi chuyen "can duyet" + danh dau bao ERP (ERP doc /api/orderbot moi lan job canh bao chay).
   */
  async periodicCheck(key) {
    const it = this.items[key];
    if (!it) return null;
    const { checkEveryMinutes, maxChecks } = settings.orderBot();
    const r = await this.check(key).catch((e) => (log.warn(`[orderbot] ${key}: ${e.message}`), null));
    if (!r) {
      it.nextCheckAt = Date.now() + checkEveryMinutes * 60e3; // loi mang / POS: khong tinh la mot lan kiem
      this._save();
      return it;
    }
    if (r.status !== "PENDING") return r;
    // Dem rieng cac lan kiem THEO NHIP (rounds): lan kiem nhanh sau cau chot don / nhan vien bam kiem khong tinh
    r.rounds = (r.rounds || 0) + 1;
    if (r.rounds >= maxChecks) {
      r.status = "REVIEW";
      r.reviewAt = Date.now();
      r.reasons = [`Đã kiểm ${r.rounds} lần (${checkEveryMinutes} phút/lần) vẫn chưa đủ thông tin: ${(r.reasons || []).join("; ") || "chưa rõ"}`];
      store.bumpStat(it.pageId, "orderBotReview");
      log.warn(`[orderbot] ${key}: ${r.rounds} lan kiem chua du -> can duyet, bao ERP`);
    } else r.nextCheckAt = Date.now() + checkEveryMinutes * 60e3;
    this._save();
    return r;
  }

  /** Quet dinh ky: don cho qua han (khach im lang) -> kiem lan cuoi, con thieu thi sang can duyet */
  async sweep() {
    try {
      this.seedDefaultProducts();
    } catch (e) {
      log.warn(`[orderbot] dat mau chu luc loi: ${e.message}`);
    }
    if (!settings.orderBot().enabled || this.sweeping) return;
    this.sweeping = true;
    try {
      await this._sweep();
    } finally {
      this.sweeping = false;
    }
  }

  async _sweep() {
    const now = Date.now();
    for (const [key, it] of Object.entries(this.items)) {
      if (now - (it.lastCustomerAt || it.firstSeen || now) > 7 * 86400000 && it.status !== "REVIEW") {
        delete this.items[key]; // don xong / bo qua qua 7 ngay: don khoi so theo doi
        continue;
      }
      // Don CAN DUYET CHI vi "thieu so nha" theo luat cu (ten lang / moc dia danh bi chan, 02/10/2026): kiem lai MOT lan
      // theo luat moi — dung thi len don (va tu xac nhan neu du cua), khong thi van nam o can duyet.
      if (it.status === "REVIEW" && !it.detailRecheck && (it.reasons || []).length && it.reasons.every((r) => /Thiếu số nhà/.test(r)) && this.enabledFor(it.pageId)) {
        it.detailRecheck = true;
        it.status = "PENDING";
        const r = await this.check(key).catch((e) => (log.warn(`[orderbot] ${key}: kiem lai dia chi loi: ${e.message}`), null));
        if (r && r.status === "PENDING") r.status = "REVIEW";
        continue;
      }
      // Don CAN DUYET: nhan vien co the da tu len don tren Pancake -> go khoi danh sach (1 lan goi POS, khong ton AI)
      if (it.status === "REVIEW" && this.enabledFor(it.pageId) && now - (it.staffCheckAt || 0) > SWEEP_MS - 1000) {
        it.staffCheckAt = now;
        try {
          const { messages } = await this.history(it.pageId, it.conversationId);
          await this.resolveIfStaffHandled(key, messages);
        } catch (e) {
          log.warn(`[orderbot] ${key}: kiem don nhan vien loi: ${e.message}`);
        }
        continue;
      }
      // Don nhap bot da len CHUAN truoc khi bat tu xac nhan (hoac truoc ban nay): kiem lai MOT lan de xac nhan.
      // Don nhan vien duyet tay / nhan vien tu len don thi khong dong vao.
      // Don nhap bi chan CHI vi "giam > 30%" truoc ban xa kho (04/10/2026): kiem lai MOT lan theo luat moi.
      if (it.status === "DONE" && it.confirmTried && !it.discountRecheck && /vượt 30% tiền hàng/.test(it.confirmNote || "")) {
        it.discountRecheck = true;
        it.confirmTried = false;
      }
      if (it.status === "DONE" && settings.orderBot().autoConfirm && !it.confirmedAt && !it.confirmTried && !it.approvedByStaff && !it.byStaffOrder && it.orderId && now - (it.doneAt || 0) < 3 * 86400000 && !/đã có đơn/.test(it.summary || "") && this.enabledFor(it.pageId)) {
        it.confirmTried = true;
        await this.check(key).catch((e) => log.warn(`[orderbot] ${key}: xac nhan don cu loi: ${e.message}`));
        continue;
      }
      if (it.status !== "PENDING" || !it.facts?.phone) continue;
      if ((it.nextCheckAt || 0) > now) continue;
      if (!this.enabledFor(it.pageId)) continue;
      await this.periodicCheck(key);
    }
    this._save();
  }

  /**
   * QUET LAI hoi thoai cu (nut tren trang Bot len don): doc hoi thoai INBOX cap nhat trong `hours` gio gan day cua cac
   * page dang bat len don, hoi thoai nao khach da nhan SDT + dia chi thi dua qua dung luong kiem tra chat nhu don moi.
   * KHONG dong vao: hoi thoai nhan vien da bo qua, don da tu xac nhan, va khach da co don THAT (khong phai nhap) trong
   * 14 ngay — hoi thoai cu thuong chua don cu, quet lai ma khong chan la tao don trung. Chay nen, tien do o list().
   */
  rescan({ hours = 24, max = 150, pageId = "", defaultCode = "" } = {}) {
    if (this.rescanState?.running) throw new Error("Đang quét lại, đợi lượt trước xong");
    const h = Math.round(Number(hours));
    if (!Number.isFinite(h) || h < 1 || h > 168) throw new Error("Số giờ quét lại phải từ 1 đến 168");
    const pid = String(pageId || "");
    if (pid && !this.bot.clients.has(pid)) throw new Error("Không tìm thấy page " + pid);
    // Chon mot page ma page do khong duoc ghi don (dang "chi log" / tat ghi don) -> noi ro, khong quet im lang ra 0
    if (pid && !this.enabledFor(pid)) throw new Error(`Page ${this.bot.pageNames.get(pid) || pid} đang tắt ghi đơn hoặc đang "chỉ log" — bật trong cài đặt page trước khi quét`);
    const ma = String(defaultCode || "").trim().toUpperCase();
    if (ma && !/^[A-Z0-9_-]{2,20}$/.test(ma)) throw new Error("Mã mẫu không hợp lệ");
    const st = (this.rescanState = { running: true, hours: h, pageId: pid, pageName: pid ? this.bot.pageNames.get(pid) || pid : "", defaultCode: ma, startedAt: Date.now(), scanned: 0, candidates: 0, checked: 0, done: 0, confirmed: 0, review: 0, skipped: 0, errors: 0, note: "" });
    this._rescan(h, Math.min(Number(max) || 150, 300), st)
      .catch((e) => ((st.note = e.message), log.warn(`[orderbot] quet lai loi: ${e.message}`)))
      .finally(() => ((st.running = false), (st.finishedAt = Date.now())));
    return st;
  }

  async _rescan(hours, max, st) {
    const cutoff = Date.now() - hours * 3600e3;
    for (const [pid, client] of this.bot.clients) {
      if (st.pageId && pid !== st.pageId) continue;
      if (!this.enabledFor(pid)) continue;
      let last;
      for (let trang = 0; trang < 30 && st.candidates < max; trang++) {
        const data = await client.getConversations({ type: "INBOX", order_by: "updated_at", last_conversation_id: last });
        const list = data.conversations || [];
        if (!list.length) break;
        let het = false;
        for (const conv of list) {
          if (parseTs(conv.updated_at) < cutoff) {
            het = true;
            break;
          }
          st.scanned++;
          const key = String(conv.id);
          const cu = this.items[key];
          if (cu && (cu.status === "DISMISSED" || cu.confirmedAt)) continue;
          let messages;
          try {
            messages = sortChrono((await client.getMessages(conv.id)).messages);
          } catch {
            st.errors++;
            continue;
          }
          const f = this.bot.customerFacts(pid, messages);
          if (!f.phone || !f.address) continue; // chua co dau hieu mua -> khong ton AI
          // Moi SDT khach tung go (toi da 3): khach doi so giua chung van bi nhan ra la da co don
          const sdt = this.customerPhones(pid, messages).slice(-3);
          let khac = [];
          for (const ph of sdt) if (!khac.length) khac = await orderSync.otherOrders(key, ph).catch(() => []);
          if (khac.length) {
            st.skipped++;
            continue; // khach da co don that -> hoi thoai nay da duoc xu ly
          }
          st.candidates++;
          this.notify(pid, key, messages, conv.from?.name || "", extractAdIds(conv));
          const it = this.items[key];
          if (!it) continue;
          if (it.status !== "PENDING") it.status = "PENDING";
          clearTimeout(this.timers.get(key));
          const r = await this.check(key, { defaultCode: st.defaultCode }).catch(() => (st.errors++, null));
          st.checked++;
          if (r?.status === "DONE") (st.done++, r.confirmedAt && st.confirmed++);
          else if (r?.status === "REVIEW") st.review++;
          if (st.candidates >= max) break;
        }
        last = list[list.length - 1].id;
        if (het || list.length < 60) break;
      }
    }
    log.info(`[orderbot] quet lai ${hours}h: doc ${st.scanned}, kiem ${st.checked}, len don ${st.done} (xac nhan ${st.confirmed}), can duyet ${st.review}, bo qua ${st.skipped}`);
  }

  /**
   * DUYET DON MOI TREN POS (nut tren trang Bot len don): liet ke don "Moi" `days` ngay qua — ca don nhan vien tu tao —
   * va ly do tung don chua chuan. CHI DOC, khong ghi gi. Nguoi xem roi bam xac nhan (confirmDrafts) moi ghi.
   * Chay NEN (startDraftPreview + draftJob): doc vai tram don mat hon mot phut, giu ket noi trinh duyet lau vay thi proxy
   * cat ngang va trang chi hien "Lỗi:" trong (su co 02/10/2026).
   */
  startDraftPreview(days = 7) {
    const d = Math.round(Number(days));
    if (!Number.isFinite(d) || d < 1 || d > 14) throw new Error("Số ngày phải từ 1 đến 14");
    if (!orderSync.enabled) throw new Error("POS chưa cấu hình");
    if (this.draftJob?.running) return this.draftJob;
    const job = (this.draftJob = { running: true, kind: "preview", days: d, startedAt: Date.now(), error: "", result: null });
    this.previewDrafts(d)
      .then((r) => (job.result = r))
      .catch((e) => ((job.error = e.message || String(e)), log.warn(`[orderbot] duyet don Moi loi: ${job.error}`)))
      .finally(() => (job.running = false));
    return job;
  }

  async previewDrafts(days = 7) {
    const d = Math.round(Number(days));
    if (!Number.isFinite(d) || d < 1 || d > 14) throw new Error("Số ngày phải từ 1 đến 14");
    if (!orderSync.enabled) throw new Error("POS chưa cấu hình");
    const all = await orderSync.recentOrders(Math.max(14, d));
    const moc = Date.now() - d * 86400e3;
    const drafts = all.filter((o) => Number(o.status) === 0 && Date.parse(String(o.inserted_at).replace(/(\.\d+)?Z?$/, "Z")) >= moc);
    const rows = [];
    for (const o of drafts) {
      const reasons = orderSync.draftProblems(o, all);
      const sa = o.shipping_address || {};
      rows.push({
        id: o.id,
        insertedAt: o.inserted_at,
        customer: o.bill_full_name || sa.full_name || "",
        phone: normalizePhone(o.bill_phone_number || sa.phone_number) || "",
        address: [sa.address, sa.commune_name, sa.district_name, sa.province_name].filter(Boolean).join(", ") || sa.full_address || "",
        items: (o.items || []).map((it) => `${it.variation_info?.display_id || it.variation_info?.name || it.product_name || "?"} x${it.quantity || 1}`),
        page: o.page?.name || this.bot.pageNames.get(String(o.page_id)) || "",
        ok: !reasons.length,
        reasons,
        warnings: hasStreetDetail(sa.address, [sa.commune_name, sa.district_name, sa.province_name, sa.new_commune_name, sa.new_province_name]) ? [] : ["chưa có số nhà / thôn xóm — shipper gọi khách"],
        // Anh chup luc xem truoc: luc xac nhan, don phai CON Y NHU VAY (nhan vien sua giua chung thi khong dong vao)
        snap: { phone: String(o.bill_phone_number || sa.phone_number || ""), conversationId: o.conversation_id || "", items: (o.items || []).map((it) => ({ variation_id: String(it.variation_id || it.variation_info?.id || ""), quantity: Number(it.quantity) })) },
      });
    }
    rows.sort((a, b) => String(b.insertedAt).localeCompare(String(a.insertedAt)));
    this.draftPreview = { days: d, at: Date.now(), rows };
    return { days: d, total: rows.length, ok: rows.filter((r) => r.ok).length, rows };
  }

  /** Xac nhan chay NEN (moi don 4–5 lan goi POS, vai chuc don la qua thoi gian proxy cho phep) — tien do o draftJob */
  startConfirmDrafts(ids = []) {
    if (this.draftJob?.running) throw new Error("Đang chạy lượt trước, đợi xong");
    const xt = this.draftPreview;
    if (!xt || Date.now() - xt.at > 30 * 60e3) throw new Error("Bản xem trước đã cũ (quá 30 phút) — bấm Kiểm tra lại trước khi xác nhận");
    const job = (this.draftJob = { running: true, kind: "confirm", startedAt: Date.now(), error: "", result: null, total: (ids || []).length, doneCount: 0 });
    this.confirmDrafts(ids, job)
      .then((r) => (job.result = r))
      .catch((e) => (job.error = e.message || String(e)))
      .finally(() => (job.running = false));
    return job;
  }

  /** Xac nhan cac don CHUAN trong lan xem truoc gan nhat (ids nguoi chon). Moi don duoc doc lai va kiem lai truoc khi ghi. */
  async confirmDrafts(ids = [], job = null) {
    const xt = this.draftPreview;
    if (!xt || Date.now() - xt.at > 30 * 60e3) throw new Error("Bản xem trước đã cũ (quá 30 phút) — bấm Kiểm tra lại trước khi xác nhận");
    const chon = new Set((ids || []).map(String));
    const out = { confirmed: [], failed: [] };
    for (const r of xt.rows) {
      if (!r.ok || !chon.has(String(r.id))) continue;
      const kq = await orderSync.confirmOrder(r.id, { conversationId: r.snap.conversationId, phone: normalizePhone(r.snap.phone), items: r.snap.items, note: "duyệt đơn Mới trên trang Bot lên đơn" }).catch((e) => ({ ok: false, reason: e.message }));
      if (kq.ok) out.confirmed.push(r.id);
      else out.failed.push({ id: r.id, reason: kq.reason });
      if (job) job.doneCount++;
    }
    log.info(`[orderbot] xac nhan don Moi: ${out.confirmed.length} don, khong xac nhan ${out.failed.length}`);
    this.draftPreview = null;
    return out;
  }

  /**
   * RESET (chu shop 02/10/2026: "reset lai bot len don"): danh sach theo doi cu (luat cu: cho 120 phut, chan thieu so nha)
   * bo di MOT lan khi ban nay chay lan dau, roi gieo lai tu hoi thoai 24 gio gan day: hoi thoai khach DA GO SDT va chua co
   * don that -> theo doi theo nhip moi, kiem ngay o luot quet toi. Khong goi AI o buoc gieo.
   */
  async resetIfNeeded() {
    if (store.state.orderBotVersion === ORDERBOT_VERSION) return false;
    const cu = Object.keys(this.items).length;
    store.state.orderBot = {};
    store.state.orderBotVersion = ORDERBOT_VERSION;
    this._save();
    log.info(`[orderbot] reset: bo ${cu} muc theo doi cu, gieo lai tu hoi thoai 24 gio`);
    await this.seed(24).catch((e) => log.warn(`[orderbot] gieo lai loi: ${e.message}`));
    return true;
  }

  async seed(hours = 24, max = 300) {
    const cutoff = Date.now() - hours * 3600e3;
    let n = 0;
    for (const [pid, client] of this.bot.clients) {
      if (!this.enabledFor(pid)) continue;
      let last;
      for (let trang = 0; trang < 20 && n < max; trang++) {
        const data = await client.getConversations({ type: "INBOX", order_by: "updated_at", last_conversation_id: last });
        const list = data.conversations || [];
        if (!list.length) break;
        let het = false;
        for (const conv of list) {
          if (parseTs(conv.updated_at) < cutoff) {
            het = true;
            break;
          }
          let messages;
          try {
            messages = sortChrono((await client.getMessages(conv.id)).messages);
          } catch {
            continue;
          }
          const sdt = this.customerPhones(pid, messages).slice(-3);
          if (!sdt.length) continue;
          let khac = [];
          for (const ph of sdt) if (!khac.length) khac = await orderSync.otherOrders(String(conv.id), ph).catch(() => []);
          if (khac.length) continue; // khach da co don that
          this.notify(pid, String(conv.id), messages, conv.from?.name || "", extractAdIds(conv), { dueNow: true });
          if (++n >= max) break;
        }
        last = list[list.length - 1].id;
        if (het || list.length < 60) break;
      }
    }
    log.info(`[orderbot] gieo lai ${n} hoi thoai co SDT`);
    return n;
  }

  /** Ap mau chu luc da chot cho page chua khai (moi muc mot lan), roi kiem lai ngay don dang treo cua page do. */
  seedDefaultProducts() {
    const daAp = (store.state.defaultProductSeeds ||= {});
    const out = [];
    for (const [pid, ten] of this.bot.pageNames) {
      // Ten Pancake tai sau khi khoi dong -> xet ca hai ten; sweep goi lai nen page doi ten muon van duoc ap
      const cacTen = [ten, this.bot.pancakeNames?.get(pid)].map(khongDau);
      for (const s of PAGE_DEFAULT_PRODUCT_SEED) {
        const k = `${pid}:${s.code}`;
        if (daAp[k] || !cacTen.includes(s.page)) continue;
        daAp[k] = Date.now();
        if (String(settings.get(pid).defaultProduct || "").trim()) continue;
        settings.update(pid, { defaultProduct: s.code });
        log.info(`[orderbot] page ${ten}: dat mau chu luc ${s.code}`);
        out.push(pid);
        this.requeuePage(pid);
      }
    }
    if (out.length) this._save();
    return out;
  }

  /**
   * Doi mau chu luc cua page -> cac hoi thoai 24 gio qua dang cho / can duyet (chua len don) duoc kiem lai NGAY voi bo
   * dem moi: ly do treo thuong chinh la "khong ro mau".
   */
  requeuePage(pageId, hours = 24) {
    const moc = Date.now() - hours * 3600e3;
    let n = 0;
    for (const it of Object.values(this.items)) {
      if (it.pageId !== String(pageId) || !["PENDING", "REVIEW"].includes(it.status) || it.orderId || (it.firstSeen || 0) < moc) continue;
      Object.assign(it, { status: "PENDING", rounds: 0, nextCheckAt: Date.now(), reviewAt: undefined });
      n++;
    }
    if (n) this._save();
    return n;
  }

  start() {
    try {
      this.seedDefaultProducts();
    } catch (e) {
      log.warn(`[orderbot] dat mau chu luc loi: ${e.message}`);
    }
    // Dung san danh muc xa/phuong ca nuoc (nen) de bot len don suy ra duoc tinh/huyen khi khach chi ghi ten phuong/xa
    orderSync.geoIndex().catch(() => null);
    this.resetIfNeeded()
      .then(async (daReset) => {
        // MOT lan sau ban doc SDT dang chip (02/10/2026): hoi thoai 24h khach da gui SDT bang chip ma bot chua thay
        // -> dua vao theo doi va kiem ngay (khong lam lai neu vua reset — reset da gieo 24h)
        if (store.state.phoneChipSeed === 1) return;
        store.state.phoneChipSeed = 1;
        this._save();
        if (!daReset) await this.seed(24);
      })
      .catch((e) => log.warn(`[orderbot] reset / gieo loi: ${e.message}`));
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
      rescan: this.rescanState || null,
      counts: {
        pending: rows.filter((r) => r.status === "PENDING").length,
        review: rows.filter((r) => r.status === "REVIEW").length,
        doneToday: rows.filter((r) => r.status === "DONE" && ngay(r.doneAt) === today).length,
        confirmedToday: rows.filter((r) => r.confirmedAt && ngay(r.confirmedAt) === today).length,
        reviewToday: rows.filter((r) => r.status === "REVIEW" && ngay(r.reviewAt || r.lastCheckAt) === today).length,
      },
      review: rows.filter((r) => r.status === "REVIEW").sort((a, b) => (b.lastCheckAt || 0) - (a.lastCheckAt || 0)),
      pending: rows.filter((r) => r.status === "PENDING").sort((a, b) => (b.lastCustomerAt || 0) - (a.lastCustomerAt || 0)).slice(0, 50),
      done: rows.filter((r) => r.status === "DONE").sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0)).slice(0, 30),
      confirmedTodayList: rows.filter((r) => r.confirmedAt && ngay(r.confirmedAt) === today).sort((a, b) => b.confirmedAt - a.confirmedAt),
    };
  }
}
