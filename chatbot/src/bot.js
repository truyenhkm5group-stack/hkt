import { config, loadSystemPrompt } from "./config.js";
import { PancakeClient } from "./pancake.js";
import { generateReply } from "./ai.js";
import { store } from "./store.js";
import { ConversationQueue } from "./queue.js";
import { log } from "./logger.js";
import { catalog } from "./catalog.js";
import { renderSystemPrompt } from "./prompt.js";
import { settings } from "./settings.js";
import { orderSync, describeOrder } from "./orders.js";
import { identifyProduct } from "./vision.js";
import { parseBody, lookupSize, parseChart } from "./sizechart.js";
import { stripHtml, stripMarkdown, splitMessage, splitIntoBubbles, describeAttachments, parseTs, imageUrls, fetchImageAsBase64, sortChrono } from "./util.js";

export const HANDOFF = "[[HANDOFF]]";
/** Cau thay the khi bot dinh dua so tai khoan / doi coc (khong duoc phep) */
export const PAYMENT_GUARD_REPLY = "Dạ về thanh toán/cọc thì nhân viên bên em sẽ hỗ trợ chị trực tiếp ạ, chị chờ em chút nhé ❤️";
// Khach bao da cung cap thong tin roi ("chi nhan roi", "gui roi ma", "noi roi", "sao hoi lai"...)
export const RECHECK_RE = /(đã|vừa|mới)\s*(nhắn|gửi|nói|bảo|cho|báo|inbox|ib)\b|\b(nhắn|gửi|nói|bảo|cho|báo|ib|inbox)\s*(rồi|r)\b|hỏi\s*(lại|hoài|mãi|nhiều lần)|(nói|bảo|nhắn)\s*(bao nhiêu|mấy)\s*lần|xem lại\s*(tin|đi)|đọc lại|có đọc (tin|không)|ở trên (rồi|kìa|đó)|chưa đọc/i;
const IMG_RE = /\[\[IMG:([^\]]+)\]\]/gi;

// Tin do Pancake tu dong chen vao hoi thoai, vd: "Đã thêm nhãn tự động: Đã đánh dấu trạng thái đơn đặt hàng là Đã đặt hàng."
// Tin nay tinh la tin cua PAGE nen de len tin cua khach -> bot tuong page da tra loi va bo qua khach (su co 2026-09-07).
export const AUTO_NOTE_RE = /nhãn tự động|đánh dấu trạng thái đơn/i;

/**
 * Cau tra loi cua bot co phai BAN TOM TAT CHOT DON (-> ghi don nhap vao POS) khong.
 * Khong bat buoc co [[HANDOFF]]: bot co the tom tat chot don luc chua co dia chi (lan do kem handoff),
 * khach gui dia chi sau roi bot tom tat lai (lan nay Gemini thuong khong kem handoff) -> van phai ghi lai,
 * neu khong don tren POS mai thieu dia chi ("Chua cung cap"). Ghi lai an toan: syncFromConversation tim don
 * nhap cu theo SDT/hoi thoai roi PUT cap nhat, khong tao don trung.
 */
/**
 * Ban tom tat chot don co bi TRONG truong bat buoc khong (SDT / dia chi / nguoi nhan).
 * Bot hay chot don khi khach moi noi "ok" ma chua cho SDT + dia chi -> don rong, nhan vien phai hoi lai.
 */
export function missingOrderFields(reply) {
  const text = String(reply || "");
  if (!/chốt đơn|lên đơn/i.test(text)) return [];
  const thieu = [];
  const lay = (re) => {
    const m = text.match(re);
    return m ? String(m[1] || "").trim() : null;
  };
  // Chu y: sau dau hai cham chi duoc an KHOANG TRANG, khong duoc an xuong dong,
  // neu khong regex se vo tinh lay noi dung cua dong ke tiep va tuong la da co thong tin.
  const sdt = lay(/(?:sđt|số điện thoại|sdt|điện thoại)\s*[:：][ \t]*([^\r\n]*)/i);
  if (sdt !== null && !/\d{9,}/.test(sdt.replace(/[^\d]/g, ""))) thieu.push("số điện thoại");
  const dc = lay(/(?:địa chỉ|dia chi)\s*[:：][ \t]*([^\r\n]*)/i);
  if (dc !== null && dc.replace(/[^a-zà-ỹ0-9]/gi, "").length < 8) thieu.push("địa chỉ nhận hàng");
  const ten = lay(/(?:người nhận|ten nguoi nhan)\s*[:：][ \t]*([^\r\n]*)/i);
  if (ten !== null && ten.replace(/[^a-zà-ỹ]/gi, "").length < 2) thieu.push("tên người nhận");
  return thieu;
}

export function isOrderSummaryReply(reply, handoff) {
  const text = String(reply || "");
  if (!/chốt đơn|lên đơn|đơn hàng của chị|đơn của chị/i.test(text)) return false;
  // Phai nhin thay dang tom tat (dong "Nguoi nhan:" / "Tong:" / "Dia chi:"), hoac co handoff KEM so dien thoai cua khach.
  // Cau "Anh cho em xin ten nguoi nhan, SDT va dia chi de em len don" KHONG phai tom tat (su co 2026-09-14: ChatGPT
  // them [[HANDOFF]] khi xin dia chi -> bot gui nham tin "tong don hang ... cam on" truoc khi khach dua dia chi).
  const coSdt = /(?<!\d)0\d{8,10}(?!\d)/.test(text.replace(/[.\s-]/g, ""));
  return /người nhận\s*:|tổng\s*:|địa chỉ\s*:/i.test(text) || (!!handoff && coSdt);
}
// Khung toi gian cho page co kich ban rieng: chi giu quy tac ky thuat, khong co noi dung ban hang cua page khac
const OWN_PROMPT_BASE = `Bạn là nhân viên tư vấn bán hàng online của {{SHOP_NAME}}, nhắn tin với khách trên Facebook/Messenger bằng tiếng Việt.

## Cách nhắn
- Thân thiện, lịch sự, ngắn gọn, mỗi tin 1-3 câu, có 1-2 icon dễ thương.
- Viết như tin nhắn thật: KHÔNG dùng markdown, không dùng dấu ** hay bảng biểu.
- Chỉ trả lời đúng lượt tin hiện tại của khách, không tự bịa tin nhắn của khách, không tự viết tiếp hội thoại.
- BẮT BUỘC: mỗi tin nhắn phải KẾT THÚC BẰNG MỘT CÂU HỎI để dẫn khách sang bước tiếp theo (xin số đo, xin thông tin nhận hàng, hỏi chốt đơn). Tuyệt đối không trả lời cụt lủn rồi dừng.
- Không bịa thông tin. Điều gì chưa chắc thì nói sẽ kiểm tra và báo lại, kèm [[HANDOFF]] để chuyển nhân viên thật.
- Cần chuyển nhân viên thật thì thêm [[HANDOFF]] vào cuối câu trả lời.
- Toàn bộ thông tin sản phẩm, giá, size, chính sách của page nằm ở mục "Hướng dẫn riêng cho page" bên dưới. BẮT BUỘC bám đúng mục đó.

## Mục tiêu
Tư vấn đúng thông tin, chốt đơn: lấy đủ size phù hợp, tên người nhận, số điện thoại và địa chỉ, rồi tóm tắt đơn cho khách xác nhận.`;

const FALLBACK_REPLY = "Dạ em đã ghi nhận, nhân viên sẽ liên hệ hỗ trợ anh/chị trong ít phút ạ.";

export class Bot {
  constructor() {
    this.clients = new Map(); // pageId -> PancakeClient
    this.pageNames = new Map(); // pageId -> ten shop
    this.pancakeNames = new Map(); // ten that lay tu Pancake
    for (const [id, p] of Object.entries(config.pages)) {
      this.clients.set(String(id), new PancakeClient(id, p.token));
      this.pageNames.set(String(id), settings.get(id).displayName || p.name || config.shopName || "");
    }
    this.systemPromptTemplate = loadSystemPrompt();
    this.queue = new ConversationQueue((_key, payload) => this.processConversation(payload));
    this.uploadCache = new Map(); // `${pageId}|${url}` -> { id, at }
    this.pauseTagIds = new Map(); // pageId -> tag id "tat bot" (tra theo BOT_PAUSE_TAG_NAME)
  }

  /**
   * Tra id tag "tat bot" cho tung page theo ten (BOT_PAUSE_TAG_NAME), vi moi page co bo tag id rieng.
   * Khong tim thay thi dung BOT_PAUSE_TAG_ID (neu co).
   */
  async init() {
    await this.refreshPageNames();
    await this.refreshPauseTags();
  }

  /** Tra lai id tag "BOT OFF" tren tung page (goi khi khoi dong, khi bam Lam moi, va dinh ky) */
  async refreshPauseTags() {
    if (!config.botPauseTagName) return;
    const want = config.botPauseTagName.trim().toLowerCase();
    for (const [pageId, client] of this.clients) {
      if (this.pauseTagIds.has(pageId)) continue;
      try {
        const res = await client.getTags();
        const tag = (res.tags || res.data || []).find((t) => String(t.text || "").trim().toLowerCase() === want);
        if (tag) {
          this.pauseTagIds.set(pageId, String(tag.id));
          log.info(`[${pageId}] Tag tat bot "${config.botPauseTagName}" -> id ${tag.id}`);
        } else {
          log.warn(`[${pageId}] Khong co tag "${config.botPauseTagName}" tren page nay, hay tao tag do trong Pancake`);
        }
      } catch (e) {
        log.warn(`[${pageId}] Khong lay duoc tags: ${e.message}`);
      }
    }
  }

  /** Lam moi ten page + tag (tu app) */
  async refresh() {
    await this.refreshPageNames();
    await this.refreshPauseTags();
    return { pauseTags: Object.fromEntries(this.pauseTagIds), names: Object.fromEntries(this.pageNames) };
  }

  /**
   * Them page luc dang chay (dan token trong app). Goi Pancake de kiem tra token, dong thoi ghi nhan
   * trang thai cac hoi thoai hien co de bot chi tra loi tin MOI tu luc them (khong tra loi hang loat tin cu).
   * Nem loi neu token sai -> khong luu.
   */
  async addPage(pageId, token, name = "") {
    const id = String(pageId).trim();
    if (!id || !token) throw new Error("Thieu page id hoac token");
    const client = new PancakeClient(id, token);
    let conversations = 0;
    for (const type of ["INBOX", "COMMENT"]) {
      const data = await client.getConversations({ type, order_by: "updated_at" });
      for (const conv of data.conversations || []) {
        store.setConvUpdatedAt(conv.id, conv.updated_at);
        conversations++;
      }
    }
    const isNew = !this.clients.has(id);
    this.clients.set(id, client);
    this.pauseTagIds.delete(id);
    if (name) config.pages[id] = { ...(config.pages[id] || {}), token, name };
    this.applyPageName(id);
    await this.refreshPageNames();
    await this.refreshPauseTags();
    log.info(`[${id}] ${isNew ? "Da them page" : "Da cap nhat token page"} "${this.pageNames.get(id) || id}" tu app (${conversations} hoi thoai hien co)`);
    return { id, name: this.pageNames.get(id) || "", conversations, isNew };
  }

  /** Go page khoi bot (chi page them tu app) */
  removePage(pageId) {
    const id = String(pageId);
    const had = this.clients.delete(id);
    this.pageNames.delete(id);
    this.pancakeNames.delete(id);
    this.pauseTagIds.delete(id);
    if (had) log.info(`[${id}] Da go page khoi bot (tu app)`);
    return had;
  }

  /** Lay ten that cua page tu Pancake (qua POS). Uu tien: ten tu dat trong app > ten that > ten trong .env */
  async refreshPageNames() {
    let names = {};
    if (catalog.enabled) {
      try {
        names = await catalog.client.getPageNames();
      } catch (e) {
        log.warn("Khong lay duoc ten page tu Pancake:", e.message);
      }
    }
    for (const id of this.clients.keys()) {
      if (names[id]) this.pancakeNames.set(id, names[id]);
      else if (!this.pancakeNames.get(id)) {
        // Page KHONG nam trong shop POS (vd page moi dan token, chua gan vao POS): POS khong biet ten ->
        // lay tu tin nhan page da gui (from.name), su co 2026-09-15 page 1163638846823256 hien toan so
        const n = await this.pageNameFromMessages(id).catch(() => "");
        if (n) this.pancakeNames.set(id, n);
      }
      this.applyPageName(id);
    }
    log.info(`Ten page tu Pancake: ${[...this.clients.keys()].map((id) => `${id}=${this.pageNames.get(id)}`).join(" | ")}`);
  }

  /** Ten page lay tu tin nhan do chinh page gui (from.name) trong cac hoi thoai gan nhat */
  async pageNameFromMessages(id) {
    const client = this.clients.get(String(id));
    if (!client) return "";
    const data = await client.getConversations({ type: "INBOX", order_by: "updated_at" });
    const list = data.conversations || [];
    // Uu tien hoi thoai page vua tra loi (chac chan co tin cua page), toi da 10 hoi thoai
    const uuTien = [...list.filter((c) => String(c.last_sent_by?.id) === String(id)), ...list].slice(0, 10);
    for (const conv of uuTien) {
      const m = await client.getMessages(conv.id);
      const fp = (m.messages || []).find((x) => String(x.from?.id) === String(id) && x.from?.name);
      if (fp) return String(fp.from.name).replace(/\s+/g, " ").trim();
    }
    return "";
  }

  applyPageName(id) {
    id = String(id);
    const custom = settings.get(id).displayName;
    const name = custom || this.pancakeNames.get(id) || config.pages[id]?.name || config.shopName || "";
    this.pageNames.set(id, name);
    return name;
  }

  pauseTagId(pageId) {
    return this.pauseTagIds.get(String(pageId)) || config.botPauseTagId || "";
  }

  getClient(pageId) {
    return this.clients.get(String(pageId));
  }

  /** Tin do page gui (nhan vien, bot, automation) hay do khach gui */
  isFromPage(msg, pageId) {
    const f = msg?.from || {};
    return String(f.id) === String(pageId) || !!f.admin_id || !!f.uid;
  }

  /**
   * Tin page gui nhung KHONG phai ai tra loi khach: loi chao tu dong cua quang cao Facebook
   * ("Chao Manh, ban thich dam do...?"), thong bao "da tra loi mot quang cao", automation cua Pancake...
   * Khach bam quang cao -> Facebook gui cau hoi mau cua khach VA loi chao cua page cung 1 giay, loi chao
   * xep sau -> tin cuoi "do page gui" nhung thuc ra khach dang cho (su co 2026-09-12, page Linh Tay CS1:
   * 8 khach hoi "Gia cua chiec dam nay la bao nhieu?" khong ai tra loi).
   */
  isPageAutomation(msg, pageId) {
    if (!this.isFromPage(msg, pageId)) return false;
    if (store.isBotMessage(msg.id)) return false;
    return !this.isHumanStaff(msg, pageId);
  }

  /**
   * Khach dang KHO CHIU vi bot noi nhieu / hoi lai ("noi nhieu met", "loi thoi", "dung nhan nua", "khoi"...).
   * Su co 2026-09-15 (Loan Hoang, Hai An Fashion): don da giao roi, bot van hoi "can tu van them gi", khach buc.
   */
  isAnnoyed(text) {
    const t = String(text || "").toLowerCase();
    if (t.length > 160) return false;
    // Chi bat cau nham vao BOT (noi nhieu, hoi lai, lam phien) - khong bat "chi met qua, mai chot" (khach met that)
    return /nói nhiều|lôi thôi|dài dòng|nhiều lời|nói (mệt|lắm|hoài|mãi)|phiền quá|làm phiền|đừng (nhắn|hỏi|bán|gửi|spam|tư vấn)|khỏi (tư vấn|bán|nhắn|hỏi|cần)|im đi|đủ rồi|spam|hỏi (hoài|mãi|lắm|nhiều)|nhắn (hoài|mãi|lắm|nhiều)|(tư vấn|hỏi|còn) gì nữa/i.test(t);
  }

  /**
   * Khach che PHI SHIP sau khi bot da gui ban chot don ("van co ship a", "ai tinh ship vao dau", "co ship thi khong lay")
   * -> ap dung ngay Buoc 1 cua quy trinh giam gia: MIEN SHIP, neu lai tong moi. Tra ve cau tra loi chuan hoac null.
   * Su co 2026-09-16 (Hang Phan, CS2): bot bam khoi "don da chot" nen chi hoi "giu don hay len combo", roi de nghi huy don.
   */
  freeShipReplyIfComplaint(pageId, messages) {
    const eff = settings.effective(pageId);
    if (eff.ownPrompt) return null; // page kich ban rieng (do nam) co chinh sach ship rieng
    const list = messages || [];
    const cuoi = list[list.length - 1];
    if (!cuoi || this.isFromPage(cuoi, pageId)) return null;
    const t = this.messageText(cuoi).toLowerCase();
    if (t.length > 200 || !/ship|phí vận chuyển|vận chuyển|phí giao/.test(t)) return null;
    if (!/có ship|tính ship|ship à|ship hả|ship ạ\?|ship sao|sao .*ship|thêm ship|cộng ship|kg lấy|ko lấy|không lấy|k lấy|miễn ship|free ship|bớt ship|bỏ ship|đắt|cao|nhiều|ship gì|ship nữa/.test(t)) return null;
    if (!this.orderClosedIn(pageId, list)) return null;
    const tinShop = list.filter((m) => this.isFromPage(m, pageId)).map((m) => this.messageText(m));
    const ganDay = tinShop.slice(-3).join("\n");
    if (/miễn (phí )?ship|miễn phí vận chuyển|freeship|free ship/i.test(ganDay)) return null; // da mien ship roi, de model xu ly
    const tomTat = [...tinShop].reverse().find((x) => /chốt đơn|tổng\s*:/i.test(x)) || "";
    if (!/\+\s*\d{2}[.,]?\d{3}\s*đ|phí (ship|vận chuyển)\s*\d{2}/i.test(tomTat)) return null; // don khong tinh ship thi thoi
    const xung = eff.customerTitle || "chị";
    const Xung = xung[0].toUpperCase() + xung.slice(1);
    const hang = tomTat.match(/(\d{3}[.,]\d{3})\s*đ?\s*\+\s*\d{2}[.,]?\d{3}/);
    const tong = hang ? `Đơn của ${xung} chỉ còn ${hang[1].replace(",", ".")}đ tiền đầm, không tính ship` : `Đơn của ${xung} chỉ tính tiền đầm, không tính ship`;
    return `Dạ em xin lỗi ${xung} ạ, em hỗ trợ MIỄN PHÍ SHIP cho mình luôn ❤️ ${tong}, nhận hàng kiểm tra rồi mới thanh toán nha ${xung}. ${Xung} chốt giúp em nhé?`;
  }

  /**
   * Ma san pham bot NEU RA nhung khong he co trong hoi thoai va khong phai mau chu luc cua page
   * -> bot tu bia (su co 2026-09-22: page chu luc Q002, khach chi noi "cho mau do do", bot chot "Dam Q004").
   */
  wrongModelInReply(reply, pageId, messages, visionCode = "") {
    const eff = settings.effective(pageId);
    const macDinh = String(eff.defaultProduct || "").toUpperCase();
    if (!macDinh) return [];
    const neu = [...new Set((String(reply || "").match(/\bQ\d{3}\b/gi) || []).map((x) => x.toUpperCase()))];
    if (!neu.length) return [];
    // Ma da xuat hien trong hoi thoai (khach hoi, hoac shop da tu van truoc do) thi duoc phep nhac lai
    const daCo = new Set(
      (messages || [])
        .flatMap((m) => String(this.messageText(m) || "").match(/\bQ\d{3}\b/gi) || [])
        .map((x) => x.toUpperCase())
    );
    if (visionCode) daCo.add(String(visionCode).toUpperCase());
    return neu.filter((x) => x !== macDinh && !daCo.has(x));
  }

  /**
   * Bot tu choi mau ma POS VAN CO (vd Q004 co Do/Nau/Den ma bot noi "chua co mau Den") -> mat don.
   * Tra ve { code, color } neu phat hien. Su co 2026-09-22 (khach Nguyen Sen, page Linen CS3).
   */
  wrongColorRefusal(reply, pageId, messages) {
    const t = String(reply || "");
    // "chua co mau Den", "khong co mau den a", "mau Den ... hien chua co"
    const m =
      t.match(/(?:chưa|không|ko)\s*(?:có|sẵn)\s*(?:mẫu\s*)?màu\s+([\p{L}\s]{2,15}?)(?=[,.!?;)\n]|$| ạ| a\b| nha| nhé)/iu) ||
      t.match(/màu\s+([\p{L}\s]{2,15}?)\s+(?:hiện\s*)?(?:shop\s*)?(?:chưa|không|ko)\s*(?:có|sẵn)/iu);
    if (!m) return null;
    const mauKhach = String(m[1] || "").trim().toLowerCase();
    if (!mauKhach || /gì|nào|khác|sắc/.test(mauKhach)) return null;
    const eff = settings.effective(pageId);
    const maTrongCau = (t.match(/\bQ\d{3}\b/i) || [])[0];
    const ma = String(maTrongCau || eff.defaultProduct || "").toUpperCase();
    if (!ma) return null;
    const sp = catalog.products.find((p) => String(p.code || "").toUpperCase() === ma);
    if (!sp) return null;
    const chuan = (s) =>
      String(s || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/đ/g, "d")
        .replace(/\s+/g, "");
    const mauPOS = [...new Set((sp.variations || []).map((v) => v.fields?.["Màu"]).filter(Boolean))];
    const khop = mauPOS.find((c) => chuan(c) === chuan(mauKhach) || chuan(mauKhach).includes(chuan(c)) || chuan(c).includes(chuan(mauKhach)));
    return khop ? { code: ma, color: khop, colors: mauPOS } : null;
  }

  /**
   * Ban tom tat CHOT DON neu mot MAU ma khach CHUA HE chon (mau co >= 2 mau) -> bot tu chon thay khach.
   * Su co 2026-09-10 (khach Hong Nguyen, page Hai An Fashion): bot hoi "Do Do hay Xanh Reu?", khach khong
   * tra loi mau ma gui luon can nang + dia chi + SDT, bot chot "Q003 mau Xanh Reu". missingOrderFields chi
   * kiem SDT/dia chi/nguoi nhan nen khong chan duoc.
   * Mau duoc coi la KHACH DA CHON khi: tin cua khach nhac ten mau (ca ten day du, hoac mot tu RIENG cua mau
   * do ma cac mau khac khong co, vd "xanh" khi chi co Do Do / Xanh Reu), hoac anh khach gui nhan dien ra mau do.
   * Tra ve { code, color, colors } neu phat hien, null neu khong.
   */
  unconfirmedColorInSummary(reply, pageId, messages, visionColor = "") {
    const t = String(reply || "");
    if (!isOrderSummaryReply(t, false)) return null;
    const eff = settings.effective(pageId);
    const ma = String((t.match(/\bQ\d{3}\b/i) || [])[0] || eff.defaultProduct || "").toUpperCase();
    if (!ma) return null;
    const sp = catalog.products.find((p) => String(p.code || "").toUpperCase() === ma);
    if (!sp) return null;
    const mauPOS = [...new Set((sp.variations || []).map((v) => v.fields?.["Màu"]).filter(Boolean))];
    if (mauPOS.length < 2) return null; // chi co 1 mau thi khong co gi de chon
    const phang = (s) =>
      String(s || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/đ/g, "d")
        .replace(/\s+/g, "");
    // Mau bot dua vao tom tat: uu tien ten dai nhat khop (tranh "Do" an vao "Do Do")
    const mauChot = [...mauPOS].sort((a, b) => b.length - a.length).find((c) => phang(t).includes(phang(c)));
    if (!mauChot) return null;
    const tinKhach = (messages || [])
      .filter((m) => !this.isFromPage(m, pageId))
      .map((m) => String(this.messageText(m) || ""))
      .join("\n");
    const nguon = `${tinKhach}\n${visionColor || ""}`;
    if (phang(nguon).includes(phang(mauChot))) return null;
    // Tu RIENG cua mau: giu dau (so khop co dau) de "đỏ" khong trung "do/đó"
    const tu = (s) => String(s || "").toLowerCase().normalize("NFC").split(/[^\p{L}]+/u).filter((w) => w.length >= 2);
    const tuMauKhac = new Set(mauPOS.filter((c) => c !== mauChot).flatMap(tu));
    const tuRieng = tu(mauChot).filter((w) => !tuMauKhac.has(w));
    const tuKhach = new Set(tu(nguon));
    if (tuRieng.some((w) => tuKhach.has(w))) return null;
    return { code: ma, color: mauChot, colors: mauPOS };
  }

  /** Cau hoi mau mac dinh khi bot van tu chon mau sau khi da bat viet lai */
  askColorReply(pageId, colors) {
    const eff = settings.effective(pageId);
    const xung = eff.customerTitle || "chị";
    const Xung = xung[0].toUpperCase() + xung.slice(1);
    return `Dạ em đã ghi nhận thông tin nhận hàng của ${xung} rồi ạ ❤️ ${Xung} lấy màu ${colors.join(" hay ")} để em lên đơn cho mình ạ?`;
  }

  /** Khach hoi ve tinh trang giao hang cua don da dat */
  isOrderStatusQuestion(text) {
    return /gửi hàng|giao hàng|gửi chưa|giao chưa|đi chưa|bao giờ (nhận|tới|đến|có|về)|khi nào (nhận|tới|đến|về)|mấy ngày (nhận|tới|về)|đơn (tới|đến|về|của)|hàng (tới|đến|về)|tới đâu|đến đâu|vận đơn|mã đơn|tra cứu|shipper|bưu tá|ship (chưa|tới|đến)/i.test(String(text || ""));
  }

  /** Don POS gan day cua khach (cache 3 phut/hoi thoai de khong goi POS lien tuc) */
  async recentOrdersCached(conversationId, phones) {
    this._orderCache ||= new Map();
    const c = this._orderCache.get(conversationId);
    if (c && Date.now() - c.at < 3 * 60 * 1000) return c.orders;
    const orders = await orderSync.recentOrdersFor(conversationId, phones).catch((e) => {
      log.warn(`Khong tra cuu duoc don POS cua ${conversationId}: ${e.message}`);
      return [];
    });
    this._orderCache.set(conversationId, { at: Date.now(), orders });
    if (this._orderCache.size > 500) this._orderCache.delete(this._orderCache.keys().next().value);
    return orders;
  }

  /** Tin do NGUOI THAT ben page gui (khong phai bot nay, khong phai automation cua Pancake) */
  isHumanStaff(msg, pageId) {
    if (!this.isFromPage(msg, pageId)) return false;
    if (store.isBotMessage(msg.id)) return false;
    const f = msg.from || {};
    if (f.ai_generated || f.is_automated) return false;
    if (config.botSenderId && (f.uid === config.botSenderId || f.admin_id === config.botSenderId)) {
      return false;
    }
    // Nguoi that gui qua Pancake/Facebook luon co uid hoac admin_id. Tin page KHONG co ca hai la
    // automation cua Facebook (loi chao quang cao, "X da tra loi mot quang cao", "Ban dang phan hoi
    // binh luan...") - khong duoc tinh la nhan vien da tra loi (su co 2026-09-12: 23 khach page CS1
    // hoi gia bi bo qua vi loi chao quang cao xep sau cau hoi cua khach).
    if (!f.uid && !f.admin_id) return false;
    return true;
  }

  /** Hoi thoai co tag "tat bot" khong. tags co the la [id] hoac [{id,text}] */
  isPaused(tags, pageId) {
    const id = this.pauseTagId(pageId);
    const name = config.botPauseTagName?.trim().toLowerCase();
    return (tags || []).some(
      (t) => (id && String(t?.id ?? t) === String(id)) || (name && String(t?.text || "").trim().toLowerCase() === name)
    );
  }

  messageText(msg) {
    return stripHtml(msg.original_message || msg.message) || describeAttachments(msg.attachments);
  }

  /** System prompt cho 1 page: thay {{SHOP_NAME}}, {{CATALOG}} + huong dan rieng cua page + ngu canh */
  /**
   * Hoi thoai nay co dang chay khuyen mai khong: chi tinh khi CHINH SHOP da gui tin co tu khoa
   * khuyen mai (vd "XẢ KHO"), de bot khong tu bao gia khuyen mai cho khach khong thuoc dot ban.
   */
  saleActiveIn(pageId, messages) {
    const eff = settings.effective(pageId);
    if (!eff.saleEnabled || !String(eff.saleTrigger || "").trim()) return false;
    const keys = String(eff.saleTrigger).split("|").map((k) => k.trim().toLowerCase()).filter(Boolean);
    if (!keys.length) return false;
    for (const m of messages || []) {
      if (!this.isFromPage(m, pageId)) continue;
      const t = String(this.messageText(m) || "").toLowerCase();
      if (keys.some((k) => t.includes(k))) return true;
    }
    return false;
  }

  /**
   * Tra bang size bang code tu chieu cao/can nang khach da noi (tin moi nhat truoc).
   * Tra ve doan ghi chu de gan vao prompt, hoac "" neu page khong co bang size / khach chua cho so do.
   */
  /** Tra size tu so do khach da noi -> { status, size, h, w } de code khac dung lai */
  sizeLookupFor(pageId, messages) {
    const eff = settings.effective(pageId);
    const chart = parseChart(eff.sizeChart);
    if (!chart) return { status: "none" };
    const list = (messages || []).filter((m) => !this.isFromPage(m, pageId)).slice(-8).reverse();
    let h = null, w = null;
    for (const m of list) {
      const b = parseBody(this.messageText(m));
      if (h === null && b.heightCm !== null) h = b.heightCm;
      if (w === null && b.weightKg !== null) w = b.weightKg;
      if (h !== null && w !== null) break;
    }
    // Bang chi 1 dong = chi can can nang (bang size dam), khong bat buoc chieu cao
    const chiCanNang = chart.length === 1;
    if (w === null || (!chiCanNang && h === null)) {
      const coNhacSoDo = list.some((m) => /(kg|ký|ki|nặng|nang|cao|cm|\dm\d)/i.test(this.messageText(m)));
      return { status: coNhacSoDo ? "chuadoc" : "none", h, w };
    }
    const r = lookupSize(chart, h, w);
    if (!r) return { status: "ngoaibang", h, w };
    if (/hết size|het size/i.test(r.size)) return { status: "hetsize", h, w, size: r.size };
    return { status: "ok", h, w, size: r.size };
  }

  /**
   * He thong da tra ra size ma bot van doi hoi lai chieu cao/can nang -> thay bang cau tra loi dung.
   * Model nho hay khong tin ket qua khi khach viet thieu don vi ("cao 165 nang 55").
   */
  fixSizeReply(reply, pageId, messages) {
    const list = (messages || []).filter((m) => !this.isFromPage(m, pageId));
    const cuoi = list[list.length - 1];
    if (!cuoi) return reply;
    // Chi xu ly khi khach VUA gui so do o tin cuoi cung
    const b = parseBody(this.messageText(cuoi));
    if (b.heightCm === null || b.weightKg === null) return reply;
    const r = this.sizeLookupFor(pageId, messages);
    if (r.status !== "ok") return reply;
    // Cau tra loi bat buoc phai nhac dung size vua tra ra, neu khong thi thay bang cau chuan
    const co = new RegExp(`size\\s*${r.size}\\b`, "i").test(reply) || new RegExp(`\\b${r.size}\\b`).test(reply);
    if (co) return reply;
    const eff = settings.effective(pageId);
    const xung = eff.customerTitle || "chị";
    const Xung = xung[0].toUpperCase() + xung.slice(1);
    log.warn(`[${pageId}] Bot khong bao dung size ${r.size} du he thong da tra ra -> thay bang cau chuan`);
    // "form US" chi dung cho page do nam (kich ban rieng); page dam dung cau thuong (su co 2026-09-16: page CS2 bao "2XL form US")
    if (eff.ownPrompt) {
      return `Dạ ${xung} mặc size ${r.size} form US là thoải mái ${xung} nhé.
Nhận hàng mặc thử không vừa đổi size thoải mái ạ.

${Xung} cho em xin tên, số điện thoại và địa chỉ để em lên đơn gửi hàng cho mình nhé ạ?`;
    }
    return `Dạ với số đo của mình, ${xung} mặc size ${r.size} là vừa đẹp ạ ❤️ Nhận hàng được kiểm tra trước, chưa vừa shop hỗ trợ đổi size nha ${xung}.
${Xung} lấy màu nào để em lên đơn cho mình ạ?`;
  }

  /**
   * Khoi bao gia ma khong kem ma anh [[IMG:...]] (ChatGPT hay quen) -> tu them ma anh cua mau dang bao,
   * de khach luon nhan duoc anh san pham cung bao gia (Hai An Fashion/Linh Tay: "gui khoi bao gia kem anh").
   */
  ensureQuoteImage(reply, pageId, messages) {
    const t = String(reply || "");
    // Khoi bao gia, hoac bot noi "em gui chi anh" ma quen ma anh
    if (!/GIÁ NIÊM YẾT|Giá ưu đãi|GIÁ XẢ|giá xả|gửi (chị|anh|mình|c|a) (ảnh|hình)|gửi ảnh|gửi hình/i.test(t) || /\[\[IMG:/i.test(t)) return t;
    const eff = settings.effective(pageId);
    if (eff.sendProductImages === false) return t;
    // Da gui anh trong hoi thoai roi thi thoi (tranh gui lai moi lan nhac gia)
    const daCoAnh = (messages || []).some((m) => this.isFromPage(m, pageId) && imageUrls(m.attachments).length);
    if (daCoAnh) return t;
    const ma = t.match(/\bQ\d{3}\b/)?.[0] || String(eff.extraPrompt || "").match(/(?:chủ lực|mặc định)[^\n]{0,60}?\b(Q\d{3})\b/i)?.[1];
    if (!ma || !catalog.products.some((p) => String(p.code || "").toUpperCase() === ma.toUpperCase())) return t;
    log.info(`[${pageId}] Khoi bao gia khong kem anh -> tu them [[IMG:${ma}]]`);
    return `${t}\n[[IMG:${ma}]]`;
  }

  sizeHintFor(pageId, messages) {
    const eff = settings.effective(pageId);
    const chart = parseChart(eff.sizeChart);
    if (!chart) return "";
    const list = (messages || []).filter((m) => !this.isFromPage(m, pageId)).slice(-8).reverse();
    let h = null, w = null;
    for (const m of list) {
      const b = parseBody(this.messageText(m));
      if (h === null && b.heightCm !== null) h = b.heightCm;
      if (w === null && b.weightKg !== null) w = b.weightKg;
      if (h !== null && w !== null) break;
    }
    if (h === null || w === null) {
      // Khach co nhac toi so do nhung he thong doc khong ra -> cam bot doan bua, phai hoi lai
      const coNhacSoDo = list.some((m) => /(kg|ký|ki|nặng|nang|cao|cm|\dm\d)/i.test(this.messageText(m)));
      if (coNhacSoDo) {
        return `\n\n## SỐ ĐO KHÁCH ĐƯA CHƯA ĐỌC ĐƯỢC\n- Hệ thống chưa lấy đủ ${h === null ? "chiều cao" : "cân nặng"} của khách. TUYỆT ĐỐI KHÔNG tự đoán size. Hãy hỏi lại khách ${h === null ? "chiều cao" : "cân nặng"} một cách ngắn gọn, lịch sự.`;
      }
      return "";
    }
    const r = lookupSize(chart, h, w);
    const soDo = h === null ? `khách nặng ${w}kg` : `khách cao ${(h / 100).toFixed(2).replace(".", "m")}, nặng ${w}kg`;
    if (!r) {
      return `

## KẾT QUẢ TRA BẢNG SIZE (hệ thống tự tra)
- ${soDo}: KHÔNG có trong bảng size của shop. Nói thật là chưa có size phù hợp và thêm [[HANDOFF]], TUYỆT ĐỐI không tự đoán một size khác.`;
    }
    if (/hết size|het size/i.test(r.size)) {
      return `

## KẾT QUẢ TRA BẢNG SIZE (hệ thống tự tra)
- ${soDo}: HẾT SIZE (shop không có size phù hợp). Nói thật với khách và thêm [[HANDOFF]], TUYỆT ĐỐI không báo bừa một size khác.`;
    }
    return `

## KẾT QUẢ TRA BẢNG SIZE (hệ thống tự tra, BẮT BUỘC dùng đúng kết quả này, không tự tính lại)
- ${soDo} -> size **${r.size}**.${eff.sizeNote ? " " + eff.sizeNote : ""}
- Hệ thống ĐÃ ĐỌC ĐƯỢC ĐẦY ĐỦ số đo của khách. Báo ngay size này cho khách rồi xin thông tin nhận hàng. TUYỆT ĐỐI KHÔNG hỏi lại chiều cao hay cân nặng, không nói là chưa nhận được số đo.`;
  }

  /**
   * Bao dam moi tin nhan ket thuc bang mot cau hoi (dan khach sang buoc tiep theo).
   * Bot hay tra loi cut ("Dạ logo là thêu anh ạ.") lam hoi thoai chet -> tu them cau hoi hop ngu canh:
   * chua co so do thi xin so do, co roi thi xin thong tin nhan hang, du het thi hoi chot don.
   */
  /** Khach chi dang cam on / noi loi ket, khong hoi gi them */
  isLoiKet(text) {
    const t = String(text || "").trim().toLowerCase();
    if (!t || t.length > 60) return false;
    if (/\?/.test(t)) return false;
    // Co dau hieu hoi han / yeu cau thi khong phai loi ket, phai tra loi tu te
    if (/(hỏi|bao giờ|khi nào|mấy|bao nhiêu|thế nào|sao|đổi|hủy|thay đổi|giao hàng|ship|size|màu|địa chỉ|số điện thoại)/.test(t)) return false;
    return /^(ok|oke|okie|okla|ừ|u|uh|uk|vâng|dạ|ừm|rồi|đủ rồi|thôi|không cần|ko cần|k cần|kg|cảm ơn|cám ơn|thank|tks|thanks|cam on|ty)\b/.test(t) || /(cảm ơn|cám ơn|thank|đủ rồi|không cần gì|ko cần gì)/.test(t);
  }

  /** Hoi thoai nay da chot don xong chua (shop da gui ban tom tat / tin cam on sau chot don) */
  orderClosedIn(pageId, messages) {
    const eff = settings.effective(pageId);
    const dau = String(eff.afterOrderText || "").trim().slice(0, 25);
    return (messages || [])
      .filter((m) => this.isFromPage(m, pageId))
      .some((m) => {
        const t = this.messageText(m);
        if (/em chốt đơn cho|đơn của (anh|chị) (đã|em)|kiểm tra giúp em thông tin/i.test(t)) return true;
        return !!dau && t.includes(dau);
      });
  }

  /**
   * Don da chot ma bot van doi xin ten/SDT/dia chi/so do -> cat cau xin do di.
   * Khach da cho het thong tin roi, hoi lai lam khach buc.
   */
  /**
   * Bot KHONG duoc tu dua so tai khoan ngan hang hay doi khach coc (chu shop 2026-09-13: "k tu y dua stk cho khach").
   * Bat khi cau tra loi vua co tu khoa tai khoan/coc vua co day so dai (so tai khoan).
   */
  isPaymentInfoReply(reply) {
    const t = String(reply || "");
    const tuKhoa = /(số tài khoản|stk|số tk|chủ tài khoản|nội dung chuyển khoản|chuyển khoản (vào|tới|đến|trước)|đặt cọc|tiền cọc|cọc trước|cọc giúp|cọc \d)/i.test(t);
    const soDai = /(?<!\d)\d{8,16}(?!\d)/.test(t.replace(/(\d)[ .-](?=\d)/g, "$1"));
    return tuKhoa && soDai;
  }

  stripAskWhenClosed(reply, pageId, messages) {
    const text = String(reply || "").trim();
    if (!text || !this.orderClosedIn(pageId, messages)) return reply;
    const XIN = /(cho em xin|cho em biết|gửi em|xin lại)[^.?!\r\n]{0,80}(tên|số điện thoại|sđt|địa chỉ|chiều cao|cân nặng|số đo|size)/i;
    if (!XIN.test(text)) return reply;
    const cau = text.split(/(?<=[.?!\r\n])\s*/).filter((c) => c.trim() && !XIN.test(c));
    const eff = settings.effective(pageId);
    const xung = eff.customerTitle || "chị";
    const Xung = xung[0].toUpperCase() + xung.slice(1);
    const con = cau.join(" ").trim();
    log.warn(`[${pageId}] Don da chot ma bot con doi xin thong tin -> da cat cau do`);
    return `${con || `Dạ vâng ạ, em đã ghi nhận yêu cầu của ${xung} rồi ạ.`}
${Xung} cần em hỗ trợ thêm gì nữa không ạ?`;
  }

  ensureEndsWithQuestion(reply, pageId, messages) {
    const text = String(reply || "").trim();
    if (!text) return reply;
    // Bo icon/khoang trang o cuoi roi xem ky tu cuoi co phai dau hoi khong
    const bare = text.replace(/[\s\p{Extended_Pictographic}‍️!.…]+$/gu, "").trim();
    // Tieng Viet hay hoi ma khong co dau hoi ("chị cho em xin SĐT nhé"), nen xet ca cac cum xin thong tin
    const duoi = text.slice(-160).toLowerCase();
    const daCoHoi =
      bare.endsWith("?") ||
      /(cho em xin|cho em biết|anh cho em|chị cho em|mình cho em|nhắn em chiều cao|chiều cao và cân nặng|chiều cao cân nặng|size phù hợp cho mình|có muốn|muốn lấy|được không|không ạ|chưa ạ|chọn màu nào|lấy màu nào|mấy bộ|mấy chiếc|mình chốt|kiểm tra giúp em)/.test(duoi);
    if (daCoHoi) return reply;

    const eff = settings.effective(pageId);
    const xung = eff.customerTitle || "chị";
    const loiKhach = (messages || [])
      .filter((m) => !this.isFromPage(m, pageId))
      .map((m) => this.messageText(m))
      .join(" ");
    const b = parseBody(loiKhach);
    const coSoDo = b.heightCm !== null && b.weightKg !== null;
    const coSdt = /(?<!\d)0\d{8,10}(?!\d)/.test(loiKhach.replace(/[.\s-]/g, ""));

    // Don da chot xong: khong ep them cau hoi nua, neu khong bot se hoi "can ho tro them gi" mai khong dut
    if (this.orderClosedIn(pageId, messages)) return reply;
    let hoi;
    if (!coSoDo) hoi = `${xung[0].toUpperCase() + xung.slice(1)} cho em xin chiều cao và cân nặng để em tư vấn size chuẩn cho mình nhé ạ?`;
    else if (!coSdt) hoi = `${xung[0].toUpperCase() + xung.slice(1)} cho em xin số điện thoại và địa chỉ để em lên đơn gửi hàng cho mình nhé ạ?`;
    else hoi = `${xung[0].toUpperCase() + xung.slice(1)} cần em hỗ trợ thêm gì nữa không ạ?`;
    log.info(`[${pageId}] Cau tra loi chua co cau hoi -> tu them: ${hoi}`);
    return `${text}\n${hoi}`;
  }

  buildSystemPrompt(pageId, { customerName, type, commentMode, saleActive = false }) {
    const shopName = this.pageNames.get(String(pageId)) || config.shopName || "shop";
    // Doc lai file moi lan de app quan ly sua prompt la co hieu luc ngay
    let template;
    try {
      template = loadSystemPrompt();
    } catch {
      template = this.systemPromptTemplate;
    }
    const eff = settings.effective(pageId);
    // Page co kich ban rieng (vd ban do nam): khong dung kich ban ban dam chung, tranh lan noi dung
    if (eff.ownPrompt) template = OWN_PROMPT_BASE;
    let extra = eff.extraPrompt;
    // Bang gia khuyen mai chi duoc ghep vao khi hoi thoai thuc su dang chay khuyen mai
    if (saleActive && String(eff.salePrompt || "").trim()) extra = eff.salePrompt; // THAY HAN ban gia thuong, khong ghep chung de bot khoi lan hai bang gia
    let prompt = renderSystemPrompt(template, { shopName, customerName, type, extraPrompt: extra, commentMode: commentMode || eff.commentMode });
    // Hoi thoai dang chay XA KHO: bo han "chien luoc giam gia bac thang" cua prompt chung.
    // Neu de lai, cac muc 499k/480k/470k/450k van nam trong prompt -> model lay nham, VA chot chan gia coi
    // do la gia hop le (findDisallowedPrices lay moi con so trong prompt lam gia duoc phep).
    // Su co 2026-09-19 (khach Tuyet Loan): dang xa 299k ma bot bao 349k roi lat qua lat lai -> khach huy don.
    if (saleActive) prompt = prompt.replace(/^[ \t]*2\. Chiến lược giảm giá bậc thang[\s\S]*?(?=^[ \t]*\d+\. |^## )/m, "");
    // ChatGPT (gpt-5.4-mini) hay tom tat lai khoi bao gia thay vi gui nguyen van nhu Gemini -> nhac lai o CUOI prompt (model bam phan cuoi tot hon)
    if (config.ai.provider === "openai" && /báo giá mẫu|khối báo giá|mẫu báo giá/i.test(extra || "")) {
      prompt += `

## NHẮC LẠI ĐỊNH DẠNG (BẮT BUỘC)
- Khi khách hỏi giá / hỏi về một mẫu lần đầu trong hội thoại: gửi NGUYÊN VĂN khối báo giá của đúng mẫu đó trong "Hướng dẫn riêng" ở trên (đủ mọi dòng, đúng số tiền, đúng màu ghi trong khối), kèm mã ảnh [[IMG:...]] tương ứng. KHÔNG tự tóm tắt, KHÔNG thêm màu ngoài khối báo giá.
- Các lượt sau mới trả lời ngắn gọn theo câu hỏi của khách.`;
    }
    return prompt;
  }

  /** Nhan payload webhook cua Pancake (event_type = messaging) */
  handleWebhook(payload) {
    if (payload?.event_type !== "messaging") {
      log.debug("Bo qua event", payload?.event_type);
      return;
    }
    const pageId = String(payload.page_id);
    const client = this.getClient(pageId);
    if (!client) {
      log.warn(`Nhan webhook cua page ${pageId} nhung chua cau hinh token cho page nay`);
      return;
    }
    if (!settings.effective(pageId).enabled) {
      log.debug(`[${pageId}] Bot dang tat cho page nay`);
      return;
    }
    const msg = payload.data?.message;
    const conv = payload.data?.conversation;
    if (!msg?.id || !conv?.id) return;

    if (store.isProcessed(msg.id)) {
      log.debug("Tin da xu ly, bo qua", msg.id);
      return;
    }
    store.markProcessed(msg.id);

    if (msg.is_removed) return;
    const type = String(msg.type || conv.type || "INBOX").toUpperCase();
    if (type !== "INBOX" && settings.effective(pageId).commentMode === "off") {
      log.debug("Bo qua binh luan (commentMode=off)");
      return;
    }
    if (this.isFromPage(msg, pageId)) {
      log.debug("Tin do page gui, bo qua");
      return;
    }
    if (this.isPaused(conv.tags, pageId)) {
      log.info(`[${pageId}] Hoi thoai ${conv.id} co tag tat bot, bo qua`);
      return;
    }
    const text = this.messageText(msg);
    if (!text) return;

    const customerName = msg.from?.name || conv.from?.name || "";
    log.info(`[${pageId}] Khach "${customerName}" (${conv.id}): ${text.slice(0, 120)}`);
    this.queue.push(`${pageId}:${conv.id}`, {
      pageId,
      conversationId: conv.id,
      type,
      customerName,
      tags: conv.tags,
    });
  }

  /**
   * Chuyen tin nhan Pancake -> lich su cho Gemini.
   * Neu VISION_ENABLED, tai toi da VISION_MAX_IMAGES anh gan nhat cua khach de Gemini xem.
   */
  /** Ghi don nhap POS tu mot hoi thoai bat ky (nut trong app / tro ly AI). Doc lai toi da 60 tin. */
  async syncOrderForConversation(pageId, conversationId) {
    const client = this.getClient(pageId);
    if (!client) throw new Error("Khong co page " + pageId);
    if (!orderSync.enabled) throw new Error("POS chưa cấu hình");
    const data = await client.getMessages(conversationId);
    let messages = sortChrono(data.messages);
    try {
      messages = await this.fetchMoreHistory(client, conversationId, messages, config.historyLimitRecheck);
    } catch {}
    const historyText = messages.slice(-60).map((m) => `${this.isFromPage(m, pageId) ? "SHOP" : "KHÁCH"}: ${this.messageText(m)}`).join("\n");
    const name = data.conv_from?.name || "";
    const r = await orderSync.syncFromConversation({ pageId, pageName: this.pageNames.get(pageId), conversationId, customerName: name, historyText });
    if (r.status !== "skipped") store.recordReply(pageId, { conversationId, customerName: name, question: "(đơn hàng - ghi thủ công)", reply: r.summary, handoff: true, dryRun: false, order: r.orderId });
    return r;
  }

  /**
   * Tai them lich su cu hon (Pancake: current_count=N tra 30 tin truoc vi tri N tinh tu tin moi nhat), gop + sap xep + bo trung.
   */
  async fetchMoreHistory(client, conversationId, current, want) {
    const byId = new Map(current.map((m) => [m.id, m]));
    let offset = 30;
    while (byId.size < want && offset < 300) {
      const more = await client.getMessages(conversationId, { current_count: offset });
      const list = more.messages || [];
      if (!list.length) break;
      const before = byId.size;
      for (const m of list) byId.set(m.id, m);
      if (byId.size === before) break; // trang nay khong co tin moi -> het lich su
      offset += 30;
    }
    return sortChrono([...byId.values()]);
  }

  async buildHistory(messages, pageId, { maxImages } = {}) {
    const history = messages.map((m) => ({
      role: this.isFromPage(m, pageId) ? "model" : "user",
      text: this.messageText(m),
      urls: config.vision.enabled && !this.isFromPage(m, pageId) ? imageUrls(m.attachments) : [],
    }));

    let budget = maxImages ?? config.vision.maxImages;
    for (let i = history.length - 1; i >= 0 && budget > 0; i--) {
      const h = history[i];
      if (h.urls.length === 0) continue;
      const imgs = [];
      for (const url of h.urls.slice(0, budget)) {
        const img = await fetchImageAsBase64(url, { maxBytes: config.vision.maxBytes });
        if (img) imgs.push(img);
        else log.warn(`Khong tai duoc anh ${url.slice(0, 100)}`);
      }
      budget -= imgs.length;
      if (imgs.length) h.images = imgs;
    }
    return history
      .map(({ role, text, images }) => ({ role, text, images }))
      .filter((h) => h.text || h.images?.length);
  }

  /**
   * Neu khach co gui anh trong lich su: chen dau hoi thoai 1 luot "anh tham chieu" (1 anh/mau/san pham tu POS)
   * de Gemini so sanh truc tiep anh khach gui voi anh that cua shop.
   */
  async attachReferenceImages(history) {
    if (!config.vision.enabled || !history.some((h) => h.images?.length)) return history;
    const refs = catalog.referenceImages(config.vision.referenceImages);
    if (!refs.length) return history;
    const images = [];
    const labels = [];
    for (const r of refs) {
      const img = await fetchImageAsBase64(r.url, { maxBytes: config.vision.maxBytes });
      if (!img) continue;
      images.push(img);
      labels.push(`Ảnh ${images.length}: ${r.label}`);
    }
    if (!images.length) return history;
    history.unshift({
      role: "user",
      text: `[ẢNH THAM CHIẾU SẢN PHẨM CỦA SHOP – không phải ảnh khách gửi. Dùng để so sánh với ảnh khách gửi sau này; khi khách gửi ảnh hãy đối chiếu kiểu dáng, màu sắc với các ảnh này để nói đúng mã và màu; nếu không giống ảnh nào thì shop chưa có mẫu đó.]\n${labels.join("\n")}`,
      images,
    });
    return history;
  }

  /**
   * Tim cac so tien (>= 10.000đ) trong cau tra loi ma KHONG co trong bang gia.
   * Bang gia = moi so tien xuat hien trong system prompt (gia POS, gia niem yet, combo, ship...) + tong cua 2 so bat ky (vd 499.000 + 25.000).
   */
  findDisallowedPrices(reply, systemPrompt) {
    const extract = (t) => {
      const out = new Set();
      const re = /(?<![A-Za-z0-9])(\d{1,3}(?:[.,]\d{3})+|\d{4,8})(?![A-Za-z0-9])|(?<![A-Za-z0-9])(\d{2,3})\s*[kK](?![A-Za-z0-9])/g;
      let m;
      while ((m = re.exec(t || ""))) {
        if (m[1]) {
          const n = Number(m[1].replace(/[.,]/g, ""));
          if (n >= 10000 && n < 100000000) out.add(n);
        } else if (m[2]) out.add(Number(m[2]) * 1000);
      }
      return out;
    };
    const allowed = extract(systemPrompt);
    for (const p of catalog.products) for (const v of p.variations) if (v.price) allowed.add(v.price);
    // Chi cho phep cac phep tinh that su xay ra khi bao gia: cong phi ship, nhan so luong.
    // KHONG cong tuy y 2 so bat ky trong prompt, vi nhu vay gan nhu moi muc gia deu duoc coi la hop le
    // (vd 449.000 + 30.000 = 479.000 -> bot tu giam gia ma khong bi chan).
    const base = [...allowed];
    for (const a of base) {
      for (const n of [1, 2, 3]) {
        allowed.add(a * n);
        // Phi ship co the la 25k (dam) hoac 20k (Q004 tu 12/9/2026)
        allowed.add(a * n + 25000);
        allowed.add(a * n + 20000);
      }
    }
    // Khach mua 3 dam: gia combo 2 dam + 1 dam le (vd 849k + 499k = 1.348k). Chi cong 2 GIA SAN PHAM
    // (>= 100k) voi nhau, khong cong phi ship/muc giam nho de bot khong tu che ra gia moi (449k + 30k...)
    const sp = base.filter((x) => x >= 100000);
    for (const a of sp) for (const b of sp) allowed.add(a + b);
    return [...extract(reply)].filter((n) => !allowed.has(n));
  }

  /**
   * Bang gia de doi chieu khi kiem tra gia: hoi thoai dang xa kho nhung cau tra loi chi noi ve mau
   * KHONG thuoc dot xa (settings.saleModels) thi phai doi chieu voi bang gia THUONG, de bot khong
   * ban Q003 gia xa 399k (su co 2026-09-12, don #4152 page Linh Tay Luxury).
   */
  priceReferenceFor(pageId, reply, systemPrompt, saleActive, ctx) {
    const eff = settings.effective(pageId);
    const saleModels = String(eff.saleModels || "").split("|").map((s) => s.trim().toUpperCase()).filter(Boolean);
    if (!saleActive || !saleModels.length) return { prompt: systemPrompt, nonSaleModels: [] };
    const mentioned = [...new Set((reply.match(/\bQ\d{3}\b/gi) || []).map((m) => m.toUpperCase()))];
    if (!mentioned.length || mentioned.some((m) => saleModels.includes(m))) return { prompt: systemPrompt, nonSaleModels: [] };
    return { prompt: this.buildSystemPrompt(pageId, { ...ctx, saleActive: false }), nonSaleModels: mentioned };
  }

  /** Tach marker [[IMG:ma]] khoi cau tra loi -> { text, imageUrls } */
  extractImageRequests(reply) {
    const refs = [];
    const text = reply.replace(IMG_RE, (_, ref) => {
      refs.push(ref.trim());
      return "";
    });
    const urls = [];
    let unlimited = false;
    for (const ref of refs) {
      // [[IMG:ALL]] = tong hop TAT CA mau dang co tren POS (1 anh moi mau, KHONG gioi han so anh, chia nhieu tin)
      const isAll = /^(all|tat ca|tất cả|tatca|tổng hợp|tong hop)$/i.test(ref.trim());
      if (isAll) unlimited = true;
      const list = isAll ? catalog.referenceImages(10000).map((r) => r.url) : catalog.findImages(ref, config.maxProductImages);
      for (const u of list) if (!urls.includes(u)) urls.push(u);
      if (!unlimited && urls.length >= config.maxProductImages) break;
    }
    return { text: text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(), imageUrls: unlimited ? urls : urls.slice(0, config.maxProductImages), refs };
  }

  /** Tai anh san pham -> upload len page -> content_id (cache 12h) */
  async uploadProductImages(client, urls) {
    const ids = [];
    for (const url of urls) {
      const key = `${client.pageId}|${url}`;
      const cached = this.uploadCache.get(key);
      if (cached && Date.now() - cached.at < 12 * 60 * 60 * 1000) {
        ids.push(cached.id);
        continue;
      }
      try {
        const img = await fetchImageAsBase64(url, { maxBytes: 15 * 1024 * 1024 });
        if (!img) throw new Error("khong tai duoc anh");
        const ext = img.mimeType.split("/")[1] || "jpg";
        const res = await client.uploadContent(Buffer.from(img.data, "base64"), `product.${ext}`, img.mimeType);
        this.uploadCache.set(key, { id: res.id, at: Date.now() });
        ids.push(res.id);
      } catch (e) {
        log.warn(`Khong upload duoc anh san pham ${url.slice(0, 80)}: ${e.message}`);
      }
    }
    return ids;
  }

  /**
   * Quet lai cac hoi thoai khach da nhan ma page chua tra loi (vd bot bi loi, het credit, hoac vua bat lai).
   * Day vao dung hang doi nhu che do poll nen van giu nguyen moi quy tac:
   * bo qua khi nhan vien da tra loi, tag "BOT OFF", tin bot da tra loi roi...
   */
  /** Hoi thoai nay co cau hoi cua khach chua ai tra loi khong (dung khi tin cuoi la tin cua page) */
  async needsCatchUp(client, conversationId, pageId) {
    const data = await client.getMessages(conversationId);
    const messages = sortChrono(data.messages || []);
    if (!messages.length) return null;
    const idx = messages.map((m) => this.isFromPage(m, pageId)).lastIndexOf(false);
    if (idx < 0) return null;
    const lastCustomer = messages[idx];
    // Sau tin khach da co nhan vien hoac bot tra loi (chi con tin tu dong cua Facebook thi van coi la dang cho)
    if (messages.slice(idx + 1).some((m) => !this.isPageAutomation(m, pageId))) return null;
    if (store.getLastHandled(conversationId) === lastCustomer.id) return null; // bot da tra loi tin nay
    if (Date.now() - parseTs(lastCustomer.inserted_at) > 48 * 3600e3) return null; // qua cu
    if (parseTs(lastCustomer.inserted_at) <= store.getUnreachableAt(conversationId)) return null; // Facebook #551, khong gui duoc
    return lastCustomer;
  }

  async catchUp({ pageId = "", hours = 6, max = 200, dryScan = false, deep = true, maxPages = deep ? 40 : 8 } = {}) {
    const cutoff = Date.now() - hours * 3600e3;
    const out = { hours, dryScan, queued: 0, scanned: 0, pages: [], items: [] };
    for (const [pid, client] of this.clients) {
      if (pageId && String(pid) !== String(pageId)) continue;
      const eff = settings.effective(pid);
      const name = this.pageNames.get(pid) || pid;
      // Page dang tat bot thi van dem cho biet co bao nhieu khach dang cho, nhung khong tra loi
      const onlyCount = !eff.enabled;
      let queued = 0, scanned = 0;
      for (const type of eff.commentMode !== "off" ? ["INBOX", "COMMENT"] : ["INBOX"]) {
        let last;
        for (let page = 0; page < maxPages; page++) {
          const data = await client.getConversations({ type, order_by: "updated_at", last_conversation_id: last });
          const list = data.conversations || [];
          if (!list.length) break;
          let stop = false;
          for (const conv of list) {
            if (parseTs(conv.updated_at) < cutoff) {
              stop = true;
              break;
            }
            scanned++;
            if (this.isPaused(conv.tags, pid)) continue;
            let force = false;
            if (String(conv.last_sent_by?.id) === String(pid)) {
              // Page gui tin cuoi. Van co the la tin quang cao/gui hang loat cua shop de len cau hoi khach.
              // Chi doc lai nhung hoi thoai Pancake danh dau CHUA DOC hoac vua nhan tin hang loat,
              // de khong phai tai ve hang nghin hoi thoai.
              // Nhan tu dong cua Pancake de len tin khach: du hoi thoai da duoc xem van phai kiem tra,
              // vi khach vua gui du thong tin va dang cho bot chot don.
              const nghi = conv.seen === false || AUTO_NOTE_RE.test(stripHtml(conv.snippet || "")) || !!store.getBroadcastSent(conv.id);
              if (!deep || !nghi) continue;
              const need = await this.needsCatchUp(client, conv.id, pid).catch(() => null);
              if (!need) continue;
              force = true;
            }
            queued++;
            out.items.push({ pageId: pid, pageName: name, conversationId: conv.id, customer: conv.from?.name || "", snippet: stripHtml(conv.snippet || "").slice(0, 80), updatedAt: conv.updated_at, force });
            if (!dryScan && !onlyCount) {
              store.setConvUpdatedAt(conv.id, conv.updated_at);
              this.queue.push(`${pid}:${conv.id}`, { pageId: pid, conversationId: conv.id, type: String(conv.type || type).toUpperCase(), customerName: conv.from?.name, tags: conv.tags, force });
            }
            if (queued >= max) {
              stop = true;
              break;
            }
          }
          last = list[list.length - 1].id;
          if (stop || list.length < 60) break;
        }
      }
      out.pages.push({ pageId: pid, name, queued, scanned, note: onlyCount ? "bot đang tắt cho page này, chỉ đếm" : "" });
      if (!onlyCount) out.queued += queued;
      out.waiting = (out.waiting || 0) + queued;
      out.scanned += scanned;
    }
    log.info(`Quet lai tin chua tra loi ${hours}h: ${out.queued} hoi thoai${dryScan ? " (chi dem, chua tra loi)" : " da dua vao hang doi"}`);
    return out;
  }

  /** Xu ly 1 hoi thoai: lay lich su -> Gemini -> gui tra loi (+ anh san pham) */
  async processConversation({ pageId, conversationId, type = "INBOX", customerName, tags, force = false }) {
    const client = this.getClient(pageId);
    if (!client) return;
    if (this.isPaused(tags, pageId)) return;
    const eff = settings.effective(pageId);
    if (!eff.enabled) return;

    const data = await client.getMessages(conversationId);
    let messages = sortChrono(data.messages); // luon cu -> moi theo inserted_at (Pancake tra thu tu khong on dinh)
    if (messages.length === 0) return;

    let last = messages[messages.length - 1];
    if (this.isFromPage(last, pageId)) {
      // Che do tra loi bu: tin cuoi la tin cua shop (vd tin gui hang loat) de len cau hoi chua ai tra loi
      const idx = messages.map((m) => this.isFromPage(m, pageId)).lastIndexOf(false);
      const lastCustomer = idx >= 0 ? messages[idx] : null;
      const humanAfter = lastCustomer && messages.slice(idx + 1).some((m) => this.isHumanStaff(m, pageId));
      const answered = lastCustomer && store.getLastHandled(conversationId) === lastCustomer.id;
      // Chi tra loi bu cau hoi con moi, khong dao lai cau hoi qua cu cua khach
      const tooOld = lastCustomer && Date.now() - parseTs(lastCustomer.inserted_at) > 48 * 3600e3;
      // Sau cau hoi cua khach chi toan tin tu dong (loi chao quang cao Facebook...) -> khach van dang cho
      const onlyAutomationAfter = lastCustomer && messages.slice(idx + 1).every((m) => this.isPageAutomation(m, pageId));
      if (!(force || onlyAutomationAfter) || !lastCustomer || humanAfter || answered || tooOld) {
        log.info(`[${pageId}] ${conversationId}: tin cuoi do page gui, khong can tra loi`);
        return;
      }
      log.info(`[${pageId}] ${conversationId}: cau hoi cua khach bi tin ${onlyAutomationAfter && !force ? "tu dong" : "shop gui"} de len, tra loi bu`);
      messages = messages.slice(0, idx + 1); // bo cac tin shop gui sau cau hoi de bot tra loi dung cau do
      last = lastCustomer;
    }
    if (store.getLastHandled(conversationId) === last.id) {
      log.debug("Da tra loi tin nay roi", last.id);
      return;
    }
    if (parseTs(last.inserted_at) <= store.getUnreachableAt(conversationId)) {
      log.info(`[${pageId}] ${conversationId}: Facebook bao khach khong the nhan tin (#551), cho khach nhan tin moi`);
      return;
    }

    // De Pancake tu dong tra loi tin dau (gui anh, bao gia); bot chi vao tu tin thu N cua khach
    const customerCount = messages.filter((m) => !this.isFromPage(m, pageId)).length;
    // Chi cho Pancake tu dong tra loi tin dau khi hoi thoai CHUA co tin nao cua page (ngoai tin tu dong);
    // hoi thoai inbox tao tu binh luan (bot da nhan rieng) thi bot tra loi ngay tin dau cua khach.
    const pageSpokeAlready = messages.some((m) => this.isFromPage(m, pageId) && !(m.from?.is_automated || m.from?.ai_generated));
    if (type === "INBOX" && customerCount < eff.minCustomerMessages && !pageSpokeAlready) {
      log.info(`[${pageId}] ${conversationId}: khach moi nhan ${customerCount} tin, bot chi tra loi tu tin thu ${eff.minCustomerMessages} (de Pancake tu dong tra loi truoc)`);
      store.bumpStat(pageId, "skippedFirst");
      store.setLastHandled(conversationId, last.id);
      return;
    }

    // Nhuong nhan vien: chi khi HUMAN_TAKEOVER_MINUTES > 0 va nhan vien that vua nhan trong khoang do.
    // 0 = tat: bot luon tra loi, tru khi tin cuoi da la cua page/nhan vien (kiem tra o tren).
    const cutoff = Date.now() - eff.humanTakeoverMinutes * 60 * 1000;
    const staffRecent = eff.humanTakeoverMinutes > 0 && messages.some(
      (m) => this.isHumanStaff(m, pageId) && parseTs(m.inserted_at) > cutoff
    );
    if (staffRecent) {
      log.info(`[${pageId}] ${conversationId}: nhan vien dang xu ly (trong ${eff.humanTakeoverMinutes} phut), bot im lang`);
      store.bumpStat(pageId, "skippedStaff");
      return;
    }
    if (data.is_banned) {
      log.info(`[${pageId}] ${conversationId}: khach bi chan, bo qua`);
      return;
    }
    if (type === "INBOX" && data.can_inbox === false) {
      log.warn(`[${pageId}] ${conversationId}: ngoai cua so nhan tin, khong gui duoc`);
      return;
    }

    // Tin chi la sticker / like / emoji (khong chu, khong anh): tra loi mau, khong ton tien Gemini
    const lastText = this.messageText(last);

    // Don da chot ma khach chi cam on / noi loi ket: dap 1 cau ngan roi dung, khong hoi lai, khong ton tien Gemini
    if (type === "INBOX" && this.isLoiKet(lastText) && this.orderClosedIn(pageId, messages)) {
      const xung = eff.customerTitle || "chị";
      const tinShop = messages.slice(-6).filter((m) => this.isFromPage(m, pageId)).map((m) => this.messageText(m));
      const daChaoRoi = tinShop.some((t) => /cảm ơn .{0,12}(đã )?(tin tưởng|ủng hộ|xác nhận)|chúc (anh|chị|mình).*(vui vẻ|tốt lành)/i.test(t));
      if (daChaoRoi) {
        log.info(`[${pageId}] ${conversationId}: don da chot, khach chi xa giao va da chao roi -> khong tra loi nua`);
        store.setLastHandled(conversationId, last.id);
        return;
      }
      const canned = `Dạ em cảm ơn ${xung} nhiều ạ ❤️ Chúc ${xung} một ngày vui vẻ ạ!`;
      log.info(`[${pageId}] ${conversationId}: don da chot, khach cam on -> chao ket thuc`);
      store.recordReply(pageId, { conversationId, customerName: customerName || "", question: lastText, reply: canned, handoff: false, dryRun: eff.dryRun });
      if (!eff.dryRun) await this.deliver(pageId, conversationId, { text: canned, type });
      store.setLastHandled(conversationId, last.id);
      return;
    }
    // Khach kho chiu vi bot noi nhieu: xin loi DUNG 1 LAN, chuyen nhan vien, roi im (khong hoi them, khong ton tien AI)
    if (type === "INBOX" && this.isAnnoyed(lastText) && !this.isOrderStatusQuestion(lastText)) {
      const xung = eff.customerTitle || "chị";
      const tinShop = messages.slice(-6).filter((m) => this.isFromPage(m, pageId)).map((m) => this.messageText(m));
      const daXinLoi = tinShop.some((t) => /xin lỗi/i.test(t));
      if (daXinLoi) {
        log.info(`[${pageId}] ${conversationId}: khach kho chiu, bot da xin loi roi -> im lang`);
        store.setLastHandled(conversationId, last.id);
        return;
      }
      const canned = `Dạ em xin lỗi ${xung} ạ, em sẽ không làm phiền thêm. Khi nào cần, ${xung} nhắn em nhé ❤️`;
      log.warn(`[${pageId}] ${conversationId}: khach kho chiu ("${lastText.slice(0, 60)}") -> xin loi 1 lan + chuyen nhan vien`);
      store.recordReply(pageId, { conversationId, customerName: customerName || "", question: lastText, reply: canned, handoff: true, dryRun: eff.dryRun });
      if (!eff.dryRun) await this.deliver(pageId, conversationId, { text: canned, type });
      store.setLastHandled(conversationId, last.id);
      const pauseTag = this.pauseTagId(pageId);
      if (pauseTag) await client.addTag(conversationId, pauseTag).catch((e) => log.warn("Khong gan duoc tag handoff:", e.message));
      return;
    }
    // Khach che phi ship sau khi chot -> mien ship ngay, khong hoi "giu don hay len combo", khong de nghi huy
    const mienShip = type === "INBOX" ? this.freeShipReplyIfComplaint(pageId, messages) : null;
    if (mienShip) {
      log.warn(`[${pageId}] ${conversationId}: khach che phi ship sau khi chot ("${lastText.slice(0, 50)}") -> mien ship`);
      store.recordReply(pageId, { conversationId, customerName: customerName || "", question: lastText, reply: mienShip, handoff: false, dryRun: eff.dryRun });
      if (!eff.dryRun) await this.deliver(pageId, conversationId, { text: mienShip, type });
      store.setLastHandled(conversationId, last.id);
      // Ghi lai don nhap tren POS thanh mien ship (tong = tien dam)
      if (eff.orderSync && orderSync.enabled && !eff.dryRun) {
        const historyText = [...messages.slice(-60).map((m) => `${this.isFromPage(m, pageId) ? "SHOP" : "KHÁCH"}: ${this.messageText(m)}`), `SHOP: ${mienShip}`].join("\n");
        orderSync
          .syncFromConversation({ pageId, pageName: this.pageNames.get(pageId), conversationId, customerName: customerName || "", historyText })
          .then((r) => log.info(`[${pageId}] ${conversationId}: cap nhat don POS sau mien ship -> ${r.status}${r.orderId ? " #" + r.orderId : ""} ${r.reason || ""}`))
          .catch((e) => log.warn(`[${pageId}] Cap nhat don POS sau mien ship loi: ${e.message}`));
      }
      return;
    }
    const stickerOnly = /^\[Khách gửi \d+ sticker\]$/.test(lastText) || /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+$/u.test(lastText);
    if (stickerOnly && !imageUrls(last.attachments).length && type === "INBOX") {
      const xung = eff.customerTitle || "chị";
      const tinShopGanDay = messages.slice(-8).filter((m) => this.isFromPage(m, pageId)).map((m) => this.messageText(m));
      // Da chao ket thuc roi ma khach lai tha tim/like tiep -> im lang, khong lam phien khach
      if (tinShopGanDay.some((t) => /chúc (anh|chị|mình).*(vui vẻ|tốt lành)/i.test(t))) {
        log.info(`[${pageId}] ${conversationId}: da chao ket thuc, khach tha sticker -> khong tra loi nua`);
        store.setLastHandled(conversationId, last.id);
        return;
      }
      // Vua chot don xong ma khach like/tha tim = dong y -> cam on va ket thuc, khong hoi tiep
      const daChotDon = tinShopGanDay.some((t) => /chốt đơn cho|đơn của (anh|chị)|kiểm tra giúp em thông tin/i.test(t));
      const canned = daChotDon
        ? `Dạ em cảm ơn ${xung} đã tin tưởng và ủng hộ shop ạ ❤️ Đơn của ${xung} em gửi đi ngay, ${xung} để ý điện thoại giúp em lúc shipper giao nhé. Chúc ${xung} một ngày vui vẻ ạ!`
        : `Dạ ${xung} cần em tư vấn thêm gì không ạ? 🥰`;
      // Vua gui dung cau nay o tin truoc ma khach lai tha sticker -> im lang, khong lap lai
      if (!daChotDon && tinShopGanDay.length && tinShopGanDay[tinShopGanDay.length - 1].trim() === canned.trim()) {
        log.info(`[${pageId}] ${conversationId}: vua hoi cau nay roi, khach tha sticker -> khong lap lai`);
        store.setLastHandled(conversationId, last.id);
        return;
      }
      log.info(`[${pageId}] ${conversationId}: sticker/emoji -> ${daChotDon ? "chao ket thuc sau khi chot don" : "tra loi mau"}`);
      store.recordReply(pageId, { conversationId, customerName: customerName || "", question: lastText, reply: canned, handoff: false, dryRun: eff.dryRun });
      if (!eff.dryRun) await this.deliver(pageId, conversationId, { text: canned, type });
      store.setLastHandled(conversationId, last.id);
      return;
    }

    // Khach bao "da nhan/gui/noi roi" -> doc lai lich su DAI hon (toi 60 tin, ca anh cu), xin loi va tra loi theo thong tin da co
    const recheck = RECHECK_RE.test(lastText);
    let fullMessages = messages;
    if (recheck) {
      try {
        const more = await this.fetchMoreHistory(client, conversationId, messages, config.historyLimitRecheck);
        fullMessages = more;
        log.info(`[${pageId}] ${conversationId}: khach bao da nhan roi -> doc lai ${fullMessages.length} tin`);
        store.bumpStat(pageId, "recheck");
      } catch (e) {
        log.warn(`[${pageId}] Khong tai them lich su: ${e.message}`);
      }
    }
    const history = await this.buildHistory(fullMessages.slice(-(recheck ? config.historyLimitRecheck : config.historyLimit)), pageId, { maxImages: recheck ? Math.max(config.vision.maxImages, 6) : undefined });
    await this.attachReferenceImages(history);
    const name = customerName || data.conv_from?.name || "";
    if (type !== "INBOX" && eff.commentMode === "off") return;
    const saleActive = this.saleActiveIn(pageId, messages);
    if (saleActive) log.info(`[${pageId}] ${conversationId}: hoi thoai dang chay khuyen mai -> dung bang gia khuyen mai`);
    let systemPrompt = this.buildSystemPrompt(pageId, { customerName: name, type, commentMode: eff.commentMode, saleActive });
    systemPrompt += this.sizeHintFor(pageId, messages);
    if (this.orderClosedIn(pageId, messages)) {
      systemPrompt += `

## ĐƠN CỦA KHÁCH NÀY ĐÃ CHỐT XONG
- Hội thoại này đã có bản chốt đơn. TUYỆT ĐỐI KHÔNG hỏi lại chiều cao, cân nặng, size, số điện thoại hay địa chỉ nữa.
- Khách nhắn thêm thì chỉ xác nhận ngắn gọn, ghi nhận yêu cầu và cảm ơn.
- Khách chê PHÍ SHIP hoặc đòi bớt SAU khi chốt ("vẫn có ship à", "ai tính ship", "có ship thì không lấy"): áp dụng ngay quy trình giảm giá của page (miễn phí ship trước), nêu lại tổng mới, mời chốt. TUYỆT ĐỐI KHÔNG hỏi "giữ đơn hay lên combo", KHÔNG đề nghị hủy đơn.
- Nếu khách yêu cầu đổi ngày giao, đổi địa chỉ, đổi size, hủy đơn hay bất cứ thay đổi nào về đơn: xác nhận đã ghi nhận rồi thêm [[HANDOFF]] để nhân viên xử lý.
- Khách chỉ cảm ơn, nói ok, chào xã giao: đáp lại ĐÚNG MỘT câu ngắn rồi dừng. TUYỆT ĐỐI KHÔNG hỏi \"cần em hỗ trợ thêm gì không\" nữa, không mời chào thêm, không kéo dài hội thoại.`;
    }

    // Khach da co don / hoi "gui hang chua, bao gio nhan": dua trang thai don THAT tren POS vao prompt
    // (truoc day bot chi noi chung chung "gui toan quoc 2-4 ngay" -> khach buc, su co Loan Hoang 2026-09-15)
    if (type === "INBOX" && orderSync.enabled && (this.orderClosedIn(pageId, messages) || this.isOrderStatusQuestion(lastText))) {
      const sdtKhach = messages.filter((m) => !this.isFromPage(m, pageId)).map((m) => this.messageText(m)).join(" ").replace(/[.\s-]/g, "");
      const phones = [...(data.conv_phone_numbers || []), ...(data.recent_phone_numbers || []), ...(sdtKhach.match(/(?<!\d)0\d{9}(?!\d)/g) || [])];
      const orders = await this.recentOrdersCached(conversationId, phones);
      if (orders.length) {
        systemPrompt += `\n\n## ĐƠN HÀNG CỦA KHÁCH TRÊN HỆ THỐNG POS (dữ liệu thật, hãy dùng để trả lời)\n${orders.map((o) => "- " + describeOrder(o)).join("\n")}\n- Khách hỏi đã gửi chưa / bao giờ nhận / đơn tới đâu: trả lời ĐÚNG theo trạng thái trên (nêu trạng thái, đơn vị vận chuyển, mã vận đơn, ngày gửi), TUYỆT ĐỐI không nói chung chung "giao toàn quốc 2–4 ngày". Trả lời 1–2 câu, không hỏi lại, không mời mua thêm.\n- Đơn "Đã gửi hàng"/"Đang giao": nhắc khách để ý điện thoại, bưu tá sẽ gọi. Đơn "Giao không thành công"/"Đang hoàn": xin lỗi, thêm [[HANDOFF]] để nhân viên xử lý.`;
        log.info(`[${pageId}] ${conversationId}: kem ${orders.length} don POS vao prompt (${orders.map((o) => "#" + o.id + " st" + o.status).join(", ")})`);
      }
    }

    // Khach vua gui anh -> nhan dien rieng (so voi anh POS) roi bao ket qua cho luot tra loi, de bot khong doan bua
    let maNhanDien = "";
    let mauNhanDien = "";
    const lastUser = history[history.length - 1];
    if (config.vision.enabled && lastUser?.role === "user" && lastUser.images?.length) {
      try {
        const idr = await identifyProduct(lastUser.images[lastUser.images.length - 1]);
        const verdict = idr.matched
          ? `KHỚP mẫu ${idr.code}${idr.color ? " màu " + idr.color : ""} (độ tin cậy: ${idr.confidence})`
          : `KHÔNG KHỚP mẫu nào của shop (độ tin cậy: ${idr.confidence})`;
        systemPrompt += `\n\n## Kết quả nhận diện ảnh khách vừa gửi (hệ thống đã so với ảnh POS)\n- ${verdict}\n- ${idr.matched ? `Hãy tư vấn/báo giá đúng mẫu ${idr.code}${idr.color ? " màu " + idr.color : ""} và gửi ảnh đúng màu đó.` : `Ảnh này KHÔNG phải mẫu shop đang bán: nói rõ shop hết/không có mẫu này, KHÔNG được báo giá hay gửi ảnh như thể là mẫu của shop, rồi gửi tổng hợp mọi mẫu đang có bằng [[IMG:ALL]] theo mục "Khi khách gửi ảnh mẫu shop KHÔNG có".`}`;
        if (idr.matched && idr.code) maNhanDien = idr.code;
        if (idr.matched && idr.color) mauNhanDien = idr.color;
        log.info(`[${pageId}] ${conversationId}: nhan dien anh -> ${verdict}`);
      } catch (e) {
        log.warn(`[${pageId}] Nhan dien anh loi: ${e.message}`);
      }
    }
    if (recheck) {
      systemPrompt += `\n\n## LƯU Ý ĐẶC BIỆT CHO LƯỢT NÀY\nKhách vừa nói rằng họ ĐÃ nhắn/gửi/cho thông tin rồi. Toàn bộ lịch sử dài hơn bình thường (kể cả ảnh khách gửi trước đó) đã được đưa vào. Hãy đọc kỹ từ đầu, tìm đúng thông tin khách đã cung cấp (số đo, cân nặng, mẫu, màu, size, số điện thoại, địa chỉ, ảnh...), rồi:\n1. Mở đầu bằng lời XIN LỖI chân thành vì đã hỏi lại (ví dụ "Dạ em xin lỗi chị, em xem lại rồi ạ").\n2. Nhắc lại ngắn gọn thông tin khách đã cho để khách thấy bạn đã đọc.\n3. Trả lời/tư vấn thẳng dựa trên thông tin đó, KHÔNG hỏi lại bất kỳ thứ gì khách đã cung cấp.\nKhông gửi lại khối báo giá hay ảnh đã gửi trước đó. Nếu thật sự không tìm thấy thông tin đó trong lịch sử, vẫn xin lỗi và nhờ khách nhắn lại giúp một lần, kèm giải thích tin nhắn có thể chưa tới.`;
    }

    const t0 = Date.now();
    const { text, finishReason, usage } = await generateReply(systemPrompt, history, {
      model: eff.model,
      temperature: eff.temperature,
    });
    let reply = text;
    let handoff = false;
    // Chot chan gia: moi so tien trong cau tra loi phai co trong bang gia (prompt + POS). Sai -> bat viet lai 1 lan, van sai -> chuyen nhan vien.
    const ctxGia = { customerName: name, type, commentMode: eff.commentMode };
    const ref = this.priceReferenceFor(pageId, reply, systemPrompt, saleActive, ctxGia);
    let badPrices = this.findDisallowedPrices(reply, ref.prompt);
    if (badPrices.length) {
      const lyDo = ref.nonSaleModels.length ? ` (mau ${ref.nonSaleModels.join(", ")} KHONG thuoc dot xa kho)` : "";
      log.warn(`[${pageId}] Gemini neu gia KHONG co trong bang gia: ${badPrices.join(", ")}${lyDo} -> viet lai`);
      store.bumpStat(pageId, "priceGuard");
      const tien = badPrices.map((n) => n.toLocaleString("vi-VN") + "đ").join(", ");
      const canhBao = ref.nonSaleModels.length
        ? `\n\n## CẢNH BÁO TỪ HỆ THỐNG\nMẫu ${ref.nonSaleModels.join(", ")} KHÔNG nằm trong đợt xả kho. Câu trả lời trước của bạn nêu mức tiền ${tien} là giá xả, KHÔNG áp dụng cho mẫu này. Viết lại: báo đúng giá thường của mẫu ${ref.nonSaleModels.join(", ")} (xem mục "CÁC MẪU KHÁC" trong hướng dẫn), nói rõ giá xả kho chỉ áp dụng cho mẫu đang xả.`
        : `\n\n## CẢNH BÁO TỪ HỆ THỐNG\nCâu trả lời trước của bạn nêu mức tiền ${tien} KHÔNG có trong Bảng giá. Viết lại câu trả lời: chỉ dùng đúng các mức giá trong Bảng giá, tuyệt đối không giảm thêm, không bịa tổng tiền. Nếu khách đang đòi giảm giá, từ chối lịch sự và mời chốt theo giá hiện có hoặc thêm [[HANDOFF]].`;
      const retry = await generateReply(systemPrompt + canhBao, history, { model: eff.model, temperature: 0.2 });
      reply = retry.text;
      badPrices = this.findDisallowedPrices(reply, this.priceReferenceFor(pageId, reply, systemPrompt, saleActive, ctxGia).prompt);
      if (badPrices.length) {
        log.warn(`[${pageId}] Van sai gia (${badPrices.join(", ")}) -> dung cau an toan + chuyen nhan vien`);
        reply = "Dạ giá này là ưu đãi tốt nhất bên em rồi ạ, em không có quyền giảm thêm. Để em chuyển nhân viên hỗ trợ chị ngay nhé ❤️ [[HANDOFF]]";
      }
    }
    // Chan bot NEU NHAM MA MAU (vd page chu luc Q002 ma bot chot "Dam Q004")
    let maLa = this.wrongModelInReply(reply, pageId, messages, maNhanDien);
    if (maLa.length) {
      const macDinh = settings.effective(pageId).defaultProduct;
      log.warn(`[${pageId}] ${conversationId}: bot neu ma ${maLa.join(", ")} khong co trong hoi thoai -> viet lai theo mau ${macDinh}`);
      store.bumpStat(pageId, "modelGuard");
      const r2 = await generateReply(
        systemPrompt +
          `\n\n## CẢNH BÁO TỪ HỆ THỐNG\nCâu trả lời trước của bạn nhắc tới mẫu ${maLa.join(", ")} — khách KHÔNG hề hỏi mẫu này và hội thoại chưa từng nói tới nó. Mẫu khách đang mua là **${macDinh}** (mẫu chủ lực của page). Viết lại câu trả lời dùng đúng mẫu ${macDinh}, giữ nguyên màu/size/thông tin khách đã cho.`,
        history,
        { model: eff.model, temperature: 0.2 }
      );
      reply = r2.text;
      maLa = this.wrongModelInReply(reply, pageId, messages, maNhanDien);
      // Van sai -> thay thang ma la bang ma chu luc (chi doi ma, giu nguyen phan con lai)
      for (const x of maLa) reply = reply.replace(new RegExp(`\\b${x}\\b`, "gi"), macDinh);
    }
    // Chan bot TU CHOI MAU ma POS van co (mat don oan)
    const tuChoiMau = this.wrongColorRefusal(reply, pageId, messages);
    if (tuChoiMau) {
      log.warn(`[${pageId}] ${conversationId}: bot noi khong co mau "${tuChoiMau.color}" nhung POS VAN CO (${tuChoiMau.code}: ${tuChoiMau.colors.join(", ")}) -> viet lai`);
      store.bumpStat(pageId, "colorGuard");
      const r3 = await generateReply(
        systemPrompt +
          `\n\n## CẢNH BÁO TỪ HỆ THỐNG\nBạn vừa nói shop KHÔNG có màu "${tuChoiMau.color}", nhưng mẫu ${tuChoiMau.code} TRÊN HỆ THỐNG CÓ ĐỦ các màu: ${tuChoiMau.colors.join(", ")}. Viết lại câu trả lời: xác nhận có màu "${tuChoiMau.color}", tư vấn tiếp và mời khách chốt đơn. TUYỆT ĐỐI không nói hết màu/không có màu này.`,
        history,
        { model: eff.model, temperature: 0.2 }
      );
      if (r3.text && !this.wrongColorRefusal(r3.text, pageId, messages)) reply = r3.text;
    }
    // Chan chot don khi con thieu SDT/dia chi: bot phai hoi xin, khong duoc gui ban tom tat bo trong
    const thieu = missingOrderFields(reply);
    if (thieu.length) {
      log.warn(`[${pageId}] Bot chot don khi con thieu ${thieu.join(", ")} -> bat viet lai`);
      const r2 = await generateReply(
        systemPrompt +
          `

## CẢNH BÁO TỪ HỆ THỐNG
Câu trả lời trước của bạn là bản tóm tắt chốt đơn nhưng còn TRỐNG: ${thieu.join(", ")}. Khách chưa cung cấp thông tin này. TUYỆT ĐỐI không gửi bản tóm tắt chốt đơn khi còn thiếu. Hãy viết lại: cảm ơn khách đã chọn, rồi hỏi xin đúng ${thieu.join(" và ")} để lên đơn. Ngắn gọn, thân thiện, không bịa số điện thoại hay địa chỉ.`,
        history,
        { model: eff.model, temperature: 0.2 }
      );
      reply = r2.text;
      if (missingOrderFields(reply).length) {
        reply = `Dạ mình cho em xin ${thieu.join(" và ")} để em lên đơn gửi hàng cho mình nha ❤️`;
        log.warn(`[${pageId}] Viet lai van thieu -> dung cau hoi xin thong tin mac dinh`);
      }
    }
    // Chan chot don voi MAU khach chua chon (bot tu chon mau thay khach)
    const mauChuaChon = this.unconfirmedColorInSummary(reply, pageId, messages, mauNhanDien);
    if (mauChuaChon) {
      log.warn(`[${pageId}] ${conversationId}: ban chot don ghi mau "${mauChuaChon.color}" nhung khach CHUA chon mau (${mauChuaChon.code}: ${mauChuaChon.colors.join(", ")}) -> bat hoi mau`);
      store.bumpStat(pageId, "colorChoiceGuard");
      const r4 = await generateReply(
        systemPrompt +
          `\n\n## CẢNH BÁO TỪ HỆ THỐNG\nCâu trả lời trước là bản tóm tắt chốt đơn ghi màu "${mauChuaChon.color}", nhưng khách CHƯA HỀ chọn màu. Mẫu ${mauChuaChon.code} có các màu: ${mauChuaChon.colors.join(", ")}. TUYỆT ĐỐI không tự chọn màu thay khách và KHÔNG gửi bản tóm tắt chốt đơn. Hãy viết lại: cảm ơn khách đã gửi thông tin, rồi hỏi khách lấy màu nào trong các màu trên. Ngắn gọn, thân thiện.`,
        history,
        { model: eff.model, temperature: 0.2 }
      );
      reply = r4.text && !this.unconfirmedColorInSummary(r4.text, pageId, messages, mauNhanDien) && !isOrderSummaryReply(r4.text, false) ? r4.text : this.askColorReply(pageId, mauChuaChon.colors);
    }
    if (reply.includes(HANDOFF)) {
      handoff = true;
      reply = reply.replaceAll(HANDOFF, "").trim();
    }
    let imageUrlsToSend = [];
    if (reply) {
      reply = this.ensureQuoteImage(reply, pageId, messages);
      const ex = this.extractImageRequests(reply);
      reply = stripMarkdown(ex.text);
      if (eff.sendProductImages && (type === "INBOX" || eff.commentMode === "inbox")) imageUrlsToSend = ex.imageUrls;
      if (ex.refs.length && ex.imageUrls.length === 0) log.warn(`[${pageId}] Gemini xin anh ${ex.refs.join(",")} nhung khong tim thay trong catalog`);
    }
    if (!reply && imageUrlsToSend.length === 0) {
      log.warn(`[${pageId}] Gemini khong tra ve noi dung (finishReason=${finishReason}), dung cau mac dinh`);
      reply = FALLBACK_REPLY;
      handoff = true;
    }
    if (reply) reply = this.fixSizeReply(reply, pageId, messages);
    if (reply) reply = this.stripAskWhenClosed(reply, pageId, messages);
    if (reply && this.isPaymentInfoReply(reply)) {
      log.warn(`[${pageId}] ${conversationId}: bot dinh gui so tai khoan / doi coc -> chan, chuyen nhan vien`);
      store.bumpStat(pageId, "paymentGuard");
      reply = PAYMENT_GUARD_REPLY;
      handoff = true;
    }
    // Chot don xong: gui kem tin cam on + nhac tong tien, thoi gian giao (cau chu do shop dat trong cai dat page)
    let daChaoChotDon = false;
    if (reply && eff.afterOrderText && isOrderSummaryReply(reply, handoff) && !reply.includes(eff.afterOrderText.slice(0, 25))) {
      reply = `${reply.trim()}

${eff.afterOrderText.trim()}`;
      daChaoChotDon = true;
    }
    // Moi tin phai ket thuc bang mot cau hoi de dan khach di tiep; bot hay quen nen tu them
    if (reply && !handoff && !daChaoChotDon) reply = this.ensureEndsWithQuestion(reply, pageId, messages);
    const nImages = history.reduce((n, h) => n + (h.images?.length || 0), 0);
    log.info(
      `[${pageId}] Bot -> "${name}" (${Date.now() - t0}ms, ${usage.totalTokenCount ?? "?"} tokens${nImages ? `, xem ${nImages} anh` : ""}${imageUrlsToSend.length ? `, gui ${imageUrlsToSend.length} anh SP` : ""})${handoff ? " [HANDOFF]" : ""}: ${reply.slice(0, 300)}`
    );

    store.bumpStat(pageId, "replies");
    if (handoff) store.bumpStat(pageId, "handoffs");
    store.recordReply(pageId, { conversationId, customerName: name, question: this.messageText(last).slice(0, 200), reply: reply.slice(0, 500), handoff, dryRun: eff.dryRun });
    if (eff.dryRun) {
      log.info(`[${pageId}] DRY_RUN: khong gui tin cho khach`);
      store.setLastHandled(conversationId, last.id);
      return;
    }

    if (type !== "INBOX" && eff.commentMode === "inbox") {
      // Binh luan -> (1) nhan rieng vao inbox: bao gia + anh, (2) tra loi cong khai: chao + bao check inbox
      const senderId = config.botSenderId || undefined;
      try {
        // Pancake private_replies can post_id (tach tu id hoi thoai `{post}_{comment}` neu tin khong co) + from_id (nguoi binh luan)
        const postId = last.post_id || String(conversationId).split("_")[0];
        const fromId = last.from?.id;
        const pr = await client.privateReply(conversationId, last.id, reply, { senderId, postId, fromId });
        if (pr?.id) store.markBotMessage(pr.id);
      } catch (e) {
        log.warn(`[${pageId}] Private reply tu binh luan loi (${e.message}) -> tra loi cong khai thay the`);
        await this.deliver(pageId, conversationId, { text: reply, type, replyToMessageId: last.id });
        store.setLastHandled(conversationId, last.id);
        return;
      }
      if (imageUrlsToSend.length) {
        // Tim hoi thoai inbox vua duoc tao tu binh luan de gui anh vao do
        try {
          const again = await client.getMessages(conversationId);
          const mine = (again.messages || []).find((m) => m.id === last.id);
          const prc = mine?.private_reply_conversation;
          const inboxId = typeof prc === "string" ? prc : prc?.id || prc?.conversation_id;
          if (inboxId) await this.deliver(pageId, inboxId, { text: "", imageUrls: imageUrlsToSend, type: "INBOX" });
          else log.warn(`[${pageId}] Khong tim thay hoi thoai inbox tu binh luan de gui anh`);
        } catch (e) {
          log.warn(`[${pageId}] Gui anh vao inbox tu binh luan loi: ${e.message}`);
        }
      }
      if (eff.commentPublicText) {
        const firstName = String(name || "").trim().split(/\s+/).pop() || "";
        const publicText = eff.commentPublicText.replaceAll("{name}", firstName ? " " + firstName : "");
        try {
          const pc = await client.replyComment(conversationId, last.id, publicText, { senderId });
          if (pc?.id) store.markBotMessage(pc.id);
        } catch (e) {
          log.warn(`[${pageId}] Tra loi cong khai binh luan loi: ${e.message}`);
        }
      }
    } else {
      try {
        await this.deliver(pageId, conversationId, { text: reply, imageUrls: imageUrlsToSend, type, replyToMessageId: last.id });
      } catch (e) {
        if (/#551|không có mặt|khong co mat/i.test(e.message)) {
          // Khach chan page / khong the nhan tin: nho lai, khong soan lai moi phut
          store.setUnreachableAt(conversationId);
          store.bumpStat(pageId, "unreachable");
          log.warn(`[${pageId}] ${conversationId}: Facebook bao khach "${customerName || ""}" khong the nhan tin (#551) -> tam dung tra loi hoi thoai nay cho den khi khach nhan tin moi`);
          return;
        }
        throw e;
      }
    }
    store.setLastHandled(conversationId, last.id);

    const pauseTag = this.pauseTagId(pageId);
    if (handoff && pauseTag) {
      try {
        await client.addTag(conversationId, pauseTag);
        log.info(`[${pageId}] ${conversationId}: da gan tag ${pauseTag} de nhan vien tiep nhan`);
      } catch (e) {
        log.warn("Khong gan duoc tag handoff:", e.message);
      }
    }

    // Chot don xong -> ghi don nhap vao POS (chay nen, khong chan tra loi). Chi khi cau tra loi la ban tom tat chot don.
    // KHONG bat buoc phai co [[HANDOFF]]: co truong hop bot tom tat chot don khi CHUA co dia chi (lan do co handoff),
    // khach gui dia chi sau roi bot tom tat lai (lan nay Gemini khong kem handoff) -> van phai ghi lai vao POS,
    // neu khong don tren POS mai o trang thai "Chua cung cap" dia chi. Ghi lai la an toan: syncFromConversation
    // tim dung don nhap cu theo SDT/hoi thoai roi PUT de cap nhat, khong tao don moi.
    if (isOrderSummaryReply(reply, handoff) && type === "INBOX" && eff.orderSync && orderSync.enabled) {
      const historyText = fullMessages
        .slice(-40)
        .map((m) => `${this.isFromPage(m, pageId) ? "SHOP" : "KHÁCH"}: ${this.messageText(m)}`)
        .concat([`SHOP: ${reply}`])
        .join("\n");
      orderSync
        .syncFromConversation({ pageId, pageName: this.pageNames.get(pageId), conversationId, customerName: name, historyText })
        .then((r) => {
          if (r.status === "skipped") log.info(`[${pageId}] ${conversationId}: khong ghi don POS (${r.reason})`);
          else store.recordReply(pageId, { conversationId, customerName: name, question: "(đơn hàng)", reply: r.summary, handoff: true, dryRun: false, order: r.orderId });
        })
        .catch((e) => log.error(`[${pageId}] ${conversationId}: ghi don POS loi: ${e.message}`));
    }
  }

  /**
   * Gui tin THAT cho khach: chu (cat <2000 ky tu) + anh san pham (upload -> content_ids).
   * Dung chung cho bot tu dong, tro ly AI va nut gui thu cong trong app.
   */
  async deliver(pageId, conversationId, { text = "", imageUrls = [], type = "INBOX", replyToMessageId } = {}) {
    const client = this.getClient(pageId);
    if (!client) throw new Error("Khong co page " + pageId);
    const senderId = config.botSenderId || undefined;
    const sent = [];
    let partial = false;
    if (text) {
      // Tach thanh nhieu tin ngan cho de doc (neu page bat), sau do van cat theo gioi han do dai cua Facebook
      const bubbles = settings.effective(pageId).splitMessages ? splitIntoBubbles(text) : [text];
      for (const part of bubbles.flatMap((x) => splitMessage(x))) {
        try {
          const res =
            type === "INBOX" || !replyToMessageId
              ? await client.sendInbox(conversationId, part, { senderId })
              : await client.replyComment(conversationId, replyToMessageId, part, { senderId });
          if (res?.id) {
            store.markBotMessage(res.id);
            sent.push(res.id);
          }
        } catch (e) {
          // Hong GIUA CHUNG (vd Facebook tra "(#551) Nguoi nay hien khong co mat"): khach DA nhan duoc
          // nhung tin dau. Neu nem loi ra ngoai thi processConversation dung giua chung, khong kip
          // setLastHandled -> luoi an toan tuong chua ai tra loi, bot soan lai tu dau va khach nhan
          // 2-3 tin gan giong nhau (su co 2026-09-12, khach Hoa Nguyen -> khach bo don).
          // Chua gui duoc gi thi van nem loi de ben ngoai thu lai.
          if (!sent.length) throw e;
          partial = true;
          log.warn(`[${pageId}] ${conversationId}: gui doan ${sent.length + 1} loi (${e.message}) - da gui ${sent.length} doan, dung lai, KHONG soan lai tu dau`);
          break;
        }
      }
    }
    let imagesSent = 0;
    if (imageUrls.length) {
      const contentIds = await this.uploadProductImages(client, imageUrls);
      // Chia thanh nhieu tin, moi tin toi da IMAGES_PER_MESSAGE anh (Facebook qua Pancake nhan toi 30/tin, nhung it anh/tin de khach de xem)
      const per = Math.max(1, config.imagesPerMessage);
      for (let i = 0; i < contentIds.length; i += per) {
        const chunk = contentIds.slice(i, i + per);
        try {
          const res = await client.sendInbox(conversationId, "", { senderId, contentIds: chunk });
          if (res?.id) {
            store.markBotMessage(res.id);
            sent.push(res.id);
          }
          imagesSent += chunk.length;
        } catch (e) {
          log.warn(`[${pageId}] Gui anh san pham loi: ${e.message}`);
        }
      }
    }
    return { messageIds: sent, imagesSent, partial };
  }

  /**
   * Gui tin do NGUOI/tro ly soan (co the chua [[IMG:ma]], markdown, [[HANDOFF]]): xu ly y het bot roi gui.
   */
  async sendComposed(pageId, conversationId, rawText) {
    let text = String(rawText || "").replaceAll(HANDOFF, "");
    const ex = this.extractImageRequests(text);
    text = stripMarkdown(ex.text);
    if (ex.refs.length && ex.imageUrls.length === 0) throw new Error(`Khong tim thay anh cho ${ex.refs.join(", ")} trong danh muc POS`);
    if (!text && ex.imageUrls.length === 0) throw new Error("Tin trong");
    const r = await this.deliver(pageId, conversationId, { text, imageUrls: ex.imageUrls });
    return { ...r, text, imageRefs: ex.refs };
  }

}
