import { config, loadSystemPrompt } from "./config.js";
import { PancakeClient } from "./pancake.js";
import { generateReply } from "./ai.js";
import { aiScope } from "./aicost.js";
import { store } from "./store.js";
import { ConversationQueue } from "./queue.js";
import { log } from "./logger.js";
import { catalog } from "./catalog.js";
import { renderSystemPrompt } from "./prompt.js";
import { settings } from "./settings.js";
import { adBots } from "./adbots.js";
import { extractAdIds, adBotPromptBlock, testImageRefs } from "./adpersona.js";
import { orderSync, describeOrder, phonesInText, norm } from "./orders.js";
import { OrderBot } from "./orderbot.js";
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

/**
 * SDT nam NGOAI noi dung chu cua tin (chip so dien thoai Messenger / Pancake): quet moi truong cua tin tru nguoi gui /
 * nguoi nhan / page (khong lay nham so cua shop). Id Facebook 15-17 chu so khong khop mau SDT 10 so.
 */
export function messagePhones(msg) {
  if (!msg || typeof msg !== "object") return [];
  const out = new Set();
  // Chi doc truong co ten giong noi chua SDT / chu, bo URL (duong dan anh CDN chua day so dai -> SDT gia)
  const di = (v, sau, khoa) => {
    if (sau > 4 || v == null) return;
    if (typeof v === "string" || typeof v === "number") {
      const t = String(v);
      if (/(phone|number|payload|title|text|value|content)/i.test(khoa) && !/^\s*(https?:|www\.)/i.test(t) && t.length <= 200) phonesInText(t).forEach((p) => out.add(p));
      return;
    }
    if (Array.isArray(v)) return void v.forEach((x) => di(x, sau + 1, khoa));
    if (typeof v === "object") for (const [k, x] of Object.entries(v)) if (!/^(from|to|page|page_id|sender|recipient|message|original_message|url|src|preview_url|image_data)$/i.test(k)) di(x, sau + 1, k);
  };
  di(msg, 0, "");
  return [...out];
}

// Ten tinh / thanh (khong dau) + viet tat thong dung: khach hay ghi dia chi khong co chu "xa / huyen / tinh"
// ("Dung, khánh thịnh an hồng an dương hp" — su co Nguyen Thi Quyen 03/10/2026: bot coi la chua co dia chi, xin lai).
const TINH_THANH = ["an giang", "ba ria vung tau", "vung tau", "bac giang", "bac kan", "bac lieu", "bac ninh", "ben tre", "binh dinh", "binh duong", "binh phuoc", "binh thuan", "ca mau", "can tho", "cao bang", "da nang", "dak lak", "dac lac", "dak nong", "dien bien", "dong nai", "dong thap", "gia lai", "ha giang", "ha nam", "ha noi", "ha tinh", "hai duong", "hai phong", "hau giang", "hoa binh", "hung yen", "khanh hoa", "kien giang", "kon tum", "lai chau", "lam dong", "lang son", "lao cai", "long an", "nam dinh", "nghe an", "ninh binh", "ninh thuan", "phu tho", "phu yen", "quang binh", "quang nam", "quang ngai", "quang ninh", "quang tri", "soc trang", "son la", "tay ninh", "thai binh", "thai nguyen", "thanh hoa", "thua thien hue", "hue", "tien giang", "tra vinh", "tuyen quang", "vinh long", "vinh phuc", "yen bai", "ho chi minh", "sai gon", "hn", "hp", "hcm", "tphcm", "sg", "brvt", "dak lak"];

/** Mot tin cua khach CO PHAI dia chi khong chu hanh chinh: co ten tinh / thanh (hoac viet tat), >= 4 tu, khong phai cau hoi. */
export function looksLikeBareAddress(text) {
  const t = String(text || "").trim();
  if (/[?？]/.test(t) || /(bao lâu|mấy ngày|có ship|ship không|ship ko|có giao|giao không|phí ship)/i.test(t)) return false;
  const n = ` ${norm(t)} `;
  if (n.trim().split(" ").length < 4) return false;
  return TINH_THANH.some((x) => n.includes(` ${x} `));
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

/** "cao 1m63, nặng 49kg" tu facts (h cm, w kg) */
function soDoText(f) {
  return [f.h ? `cao ${(f.h / 100).toFixed(2).replace(".", "m")}` : "", f.w ? `nặng ${f.w}kg` : ""].filter(Boolean).join(", ");
}

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
    this.orderBot = new OrderBot(this); // Bot len don doc lap: gop thong tin, xac nhan dia chi, len don / can duyet
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
    return /nói nhiều|lôi thôi|dài dòng|nhiều lời|nói (mệt|lắm|hoài|mãi)|phiền quá|làm phiền|đừng (nhắn|hỏi|bán|gửi|spam|tư vấn)|khỏi (tư vấn|bán|nhắn|hỏi|cần)|im đi|đủ rồi|spam|hỏi (hoài|mãi|lắm|nhiều)|nhắn (hoài|mãi|lắm|nhiều)|(tư vấn|hỏi|còn) gì nữa|đồ điên|điên (à|hả|ạ)|(?:^|\s)(k|ko|không|hông) (đọc|đoc|doc) (tn|tin|tin nhắn)|trở đi trở lại|(?:^|\s)(k|ko|không|hông) (mua|lấy) nữa|(hỏi|xin) (đi )?hỏi lại|(gửi|nói|cho) \d+ lần rồi|\d+ lần (gửi|nói) rồi/i.test(t);
  }

  /**
   * Khach XIN HUY DON: "retain" = lan dau -> hoi ly do, sua loi cua shop, dua uu dai giu don (KHONG xac nhan huy);
   * "accept" = khach xin huy LAN NUA sau khi shop da hoi -> ghi nhan huy + chuyen nhan vien; null = khong xin huy, hoac
   * sau tin huy khach da dong y giu don. Chu shop 02/10/2026 (Thu Thuy, Linh Tay CS1: "Dạ cho e hủy nha c" -> bot ghi
   * nhan huy luon): "phải hỏi lại tại sao, thuyết phục khách mua, có thể giảm giá thêm, sao hủy luôn vậy".
   */
  cancelStage(pageId, messages) {
    const HUY = /(hủy|huỷ|hũy|cancel|bỏ đơn|(?:^|\s)(không|ko|k|hông) (lấy|mua|nhận|đặt) (nữa|đâu)|thôi (không|ko|k) (lấy|mua|đặt))/i;
    const HOI = /\?|được (không|ko|k)\b|đc (không|ko|k)\b|có được|có (hủy|huỷ) được/i; // hoi "huy duoc khong" la hoi, chua phai xin huy
    const GIU = /^(ok|oke|okie|ừ|uh|vâng|dạ vâng|được|đc|đồng ý)(?![\p{L}])|giữ (đơn|lại)|vẫn (lấy|mua|nhận)|(lấy|nhận) (nhé|nha|nhe)|chốt|gửi (đi|hàng đi)/iu;
    const khach = (messages || []).filter((m) => !this.isFromPage(m, pageId)).map((m) => String(this.messageText(m) || "").normalize("NFC").trim());
    const laHuy = (t) => HUY.test(t) && !HOI.test(t);
    let cuoi = -1;
    let soLan = 0;
    khach.forEach((t, i) => {
      if (laHuy(t)) (cuoi = i), soLan++;
    });
    if (cuoi < 0) return null;
    if (khach.slice(cuoi + 1).some((t) => GIU.test(t) && !laHuy(t))) return null;
    return soLan >= 2 ? "accept" : "retain";
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

  /**
   * Sua moi cau HEN SO NGAY GIAO HANG trong tra loi ve dung thoi gian shop dat (settings.deliveryDays). Chi dung vao
   * khoang "N–M ngay" nam cung cau voi tu chi giao hang, de khong sua nham "doi tra trong 7 ngay"...
   */
  fixDeliveryDays(reply) {
    const t = String(reply || "");
    const dung = settings.deliveryDays();
    const [a, b] = dung.split("–");
    let doi = 0;
    const moi = t.replace(/[^.?!\n]*[.?!\n]?/g, (cau) => {
      if (!/(giao|nhận hàng|nhận được hàng|ship|vận chuyển|gửi hàng|hàng tới|hàng đến)/i.test(cau)) return cau;
      return cau.replace(/(\d{1,2})\s*(-|–|—|đến|tới)\s*(\d{1,2})(\s*ngày)/gi, (m0, x, _s, y, ngay) => {
        if (x === a && y === b) return m0;
        doi++;
        return `${dung}${ngay}`;
      });
    });
    if (doi) log.info(`Sua thoi gian giao hang trong tra loi ve ${dung} ngay (${doi} cho)`);
    return moi;
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
    const t = stripHtml(msg.original_message || msg.message) || describeAttachments(msg.attachments);
    // SDT khach bam nut "chia se so dien thoai" cua Messenger (Pancake hien chip XANH): so khong nam trong noi dung chu
    // ma o truong khac cua tin (phone_info / quick_reply / attachments). Su co Nhung Le 02/10/2026: khach gui
    // "0355734749" bang chip, bot van chot "CHƯA CÓ SỐ ĐIỆN THOẠI" va bot len don khong thay SDT.
    const them = messagePhones(msg).filter((p) => !phonesInText(t).includes(p));
    return them.length ? `${t ? t + " " : ""}${them.join(" ")}`.trim() : t;
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
    // Tim so do tren MOI tin khach da tai (khong chi 8 tin cuoi): su co 2026-09-26 (Hoai Thu, Linh Tay CS1)
    // khach nhan nhieu tin ngan ("Dung vay", "Co le"...) day tin 60kg/1m60 ra khoi 8 tin -> bot hoi lai 3 lan, khach bo di.
    const tatCa = (messages || []).filter((m) => !this.isFromPage(m, pageId)).reverse();
    const list = tatCa.slice(0, 8);
    let h = null, w = null;
    for (const m of tatCa) {
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
   * NHUNG GI KHACH DA DUA (doc tu tin cua KHACH, khong tu cau cua shop): SDT, dia chi, size.
   * Su co 2026-09-29 (Ta Thuy, page Linh Tay): khach da chon "Mau do do" + "Sai XL", gui dia chi + SDT, vay ma bot
   * van xin dia chi va xin chieu cao/can nang — khach tra loi "O tren" + like roi thoi.
   *  - size: khach tu chon (size XL / sai XL / sz L / tin chi co "XL") HOAC bang size tra ra tu so do.
   *  - dia chi: mot tin khach co tu chi dia danh (phuong/xa/quan/huyen/TP/tinh/duong/ngo/thon/so nha...).
   */
  /** So do khach da gui (tin moi nhat truoc): { h, w } — null la chua co. Khong can bang size. */
  customerMeasurements(pageId, messages) {
    let h = null, w = null;
    for (const m of (messages || []).filter((x) => !this.isFromPage(x, pageId)).reverse()) {
      const b = parseBody(this.messageText(m));
      if (h === null && b.heightCm !== null) h = b.heightCm;
      if (w === null && b.weightKg !== null) w = b.weightKg;
      if (h !== null && w !== null) break;
    }
    return { h, w };
  }

  customerFacts(pageId, messages, { noStored = false } = {}) {
    const loi = (messages || []).filter((m) => !this.isFromPage(m, pageId)).map((m) => String(this.messageText(m) || ""));
    const phone = loi.some((t) => phonesInText(t).length > 0);
    const DIA_CHI = /(phường|phuong|xã|thị trấn|thị xã|quận|huyện|huyen|tp\.?\s|thành phố|thanh pho|tỉnh|tinh\s|đường|duong\s|ngõ|ngách|hẻm|kiệt|thôn|xóm|ấp|tổ\s*\d|khu phố|số nhà|chung cư|kđt|khu đô thị|tòa|toà|block)/i;
    let address = null;
    for (const t of loi) {
      const bo = t.replace(/(?<![0-9])(?:0|\+?84)[1-9][0-9.\s-]{7,12}(?![0-9])/g, " ").trim();
      if (bo.length >= 10 && (DIA_CHI.test(bo) || looksLikeBareAddress(bo)) && bo.split(/\s+/).length >= 3) address = bo.slice(0, 160);
    }
    // "size XL", "sai xl", va ca dong tu chon size: "Mình đặt xl", "lấy L", "mặc size M", "cỡ XL" (su co 01/10/2026,
    // Thuy Nguyen Diem, Linh Tay Luxury: khach nhan "Mình đặt xl" hai lan, bot van xin chieu cao can nang 4 lan)
    const SIZE = /(?:^|[^a-z0-9à-ỹ])(?:size|sai|sz|sài|siz|cỡ)\s*(xxs|xs|s|m|l|xl|xxl|xxxl|[2-5]xl|\d{2})(?![a-z0-9à-ỹ])/i;
    const DONG_TU_SIZE = /(?:^|[^a-z0-9à-ỹ])(?:đặt|dat|lấy|lay|chọn|chon|mặc|mac|chốt|chot)\s+(?:size\s*|sz\s*|cỡ\s*)?(xs|s|m|l|xl|xxl|xxxl|[2-5]xl)(?![a-z0-9à-ỹ])/i;
    const MOT_SIZE = /^\s*(?:size\s*)?(xs|s|m|l|xl|xxl|xxxl|[2-5]xl)\s*(?:nha|nhé|nhe|ạ|a|em|ha)?\s*[.!]?\s*$/i;
    let size = null;
    for (const t of loi) {
      const m = t.match(SIZE) || t.match(DONG_TU_SIZE) || t.match(MOT_SIZE);
      if (m) size = m[1].toUpperCase();
    }
    let sizeFrom = size ? "khach" : null;
    if (!size) {
      const r = this.sizeLookupFor(pageId, messages);
      if (r.status === "ok") (size = r.size), (sizeFrom = "bang");
    }
    // DA GUI SO DO (du chieu cao + can nang, hoac can nang voi bang size chi theo can nang) — KE CA khi chua tra ra size
    // (page chua co bang size / so do ngoai bang). Su co 01/10/2026 (Ho Thi Lien, Linh Tay Luxury): khach gui "cao 1.63
    // nang 49 kg" nhung page khong tra ra size -> he thong coi nhu chua co so do va bot xin lai chieu cao can nang.
    const { h, w } = this.customerMeasurements(pageId, messages);
    const chart = parseChart(settings.effective(pageId).sizeChart);
    const measured = w !== null && (h !== null || !!(chart && chart.length === 1));
    const facts = { phone, address, size, sizeFrom, color: this.customerColor(pageId, messages), measured, h, w };
    // Ho so don da ghi (khach da cho du thong tin quanh luc gui SDT): tin cu troi khoi cua so ~30 tin thi van nho
    const luu = noStored ? null : this.scopedOrderInfo(pageId);
    if (luu) {
      const s = luu.facts || {};
      facts.phone = true;
      facts.address ||= s.address || null;
      if (!facts.size && s.size) (facts.size = s.size), (facts.sizeFrom = s.sizeFrom || "khach");
      facts.color ||= s.color || null;
      if (!facts.measured && s.measured) (facts.measured = true), (facts.h = s.h ?? null), (facts.w = s.w ?? null);
    }
    return facts;
  }

  /**
   * Ho so don cua HOI THOAI DANG XU LY (doc tu pham vi luot xu ly), chi khi da du thong tin. Ngoai luot xu ly -> null.
   */
  scopedOrderInfo(pageId) {
    const conv = aiScope.getStore()?.conversationId;
    if (!conv) return null;
    const info = store.getOrderInfo(conv);
    return info?.complete && info.p === String(pageId) ? info : null;
  }

  /**
   * Khach DA GUI SDT: xet 30 tin truoc tin chua SDT (va moi tin sau no) xem da DU thong tin len don chua —
   * SDT + dia chi + so do/size + mau (mau chi bat buoc khi mau dang ban co tu 2 mau). Ham thuan, khong doc/ghi store.
   * Chu shop 02/10/2026: "nếu đơn đã có sđt thì check 30 tin trước thời điểm cho sđt, đủ thông tin thì không hỏi lại
   * nữa, kết thúc hội thoại sớm" (su co Bui Phuong Vy: bot hoi "Em lên đơn…" 6 lan va xin lai so do 3 lan).
   */
  orderInfoFromPhone(pageId, messages) {
    const list = messages || [];
    let idx = -1;
    for (let i = list.length - 1; i >= 0; i--) {
      if (!this.isFromPage(list[i], pageId) && phonesInText(this.messageText(list[i])).length) {
        idx = i;
        break;
      }
    }
    if (idx < 0) return null;
    const vung = list.slice(Math.max(0, idx - 30));
    const f = this.customerFacts(pageId, vung, { noStored: true });
    const canMau = this.productColors(pageId, vung).length > 1;
    const complete = !!f.phone && !!f.address && (!!f.size || f.measured) && (!!f.color || !canMau);
    return {
      complete,
      phoneMsgId: list[idx].id || null,
      before: idx,
      facts: { address: f.address, size: f.size, sizeFrom: f.sizeFrom, color: f.color, measured: f.measured, h: f.h, w: f.w },
    };
  }

  /**
   * Cap nhat ho so don cua hoi thoai truoc khi tra loi. Cua so Pancake chi ~30 tin: SDT nam sat dau cua so (chua du
   * 30 tin truoc no) hoac da troi ra ngoai (Pancake van giu SDT cua hoi thoai) -> doc them lich su, toi da 1 lan / 10 phut
   * khi chua du. Da du thi ghi lai, cac luot sau khong doc lai nua.
   */
  async refreshOrderInfo(client, pageId, conversationId, messages, data) {
    const cu = store.getOrderInfo(conversationId);
    if (cu?.complete && cu.p === String(pageId)) return cu;
    let info = this.orderInfoFromPhone(pageId, messages);
    const cuaSoDay = (messages || []).length >= 20;
    const sdtNgoai = !info && cuaSoDay && [...(data?.conv_phone_numbers || []), ...(data?.recent_phone_numbers || [])].length > 0;
    const thieuTruoc = !!info && !info.complete && info.before < 30 && cuaSoDay;
    if ((sdtNgoai || thieuTruoc) && !(cu && Date.now() - (cu.t || 0) < 10 * 60e3)) {
      try {
        const dai = await this.fetchMoreHistory(client, conversationId, messages, 120);
        info = this.orderInfoFromPhone(pageId, dai) || info;
      } catch (e) {
        log.warn(`[${pageId}] ${conversationId}: khong doc them duoc lich su de xet ho so don (${e.message})`);
      }
      if (!info) store.setOrderInfo(conversationId, { p: String(pageId), complete: false });
    }
    if (!info) return null;
    store.setOrderInfo(conversationId, { p: String(pageId), complete: info.complete, phoneMsgId: info.phoneMsgId, facts: info.facts });
    if (info.complete) log.info(`[${pageId}] ${conversationId}: khach da cho DU thong tin quanh luc gui SDT -> coi nhu don da chot, thoi hoi them`);
    return info.complete ? info : null;
  }

  /** Cac mau tren POS cua mau dang ban (ma nhac gan nhat trong hoi thoai, hoac Mau chu luc cua page). Khong ro -> []. */
  productColors(pageId, messages) {
    const eff = settings.effective(pageId);
    const tatCa = (messages || []).map((m) => String(this.messageText(m) || ""));
    const maNhac = tatCa.flatMap((t) => t.match(/\bQ\d{3}\b/gi) || []).pop();
    const ma = String(maNhac || eff.defaultProduct || "").toUpperCase();
    const sp = ma && catalog.products.find((p) => String(p.code || "").toUpperCase() === ma);
    if (!sp) return [];
    return [...new Set((sp.variations || []).map((v) => v.fields?.["Màu"]).filter(Boolean))];
  }

  /**
   * Mau KHACH da chon cho mau dang ban (ma nhac gan nhat trong hoi thoai, hoac Mau chu luc cua page): tin khach nhac
   * ten mau day du, hoac mot tu RIENG cua mau do (cung luat voi unconfirmedColorInSummary). Khong doan: null = chua chon.
   */
  customerColor(pageId, messages) {
    const mauPOS = this.productColors(pageId, messages);
    if (!mauPOS.length) return null;
    const phang = (x) => String(x || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/\s+/g, "");
    const tu = (x) => String(x || "").toLowerCase().normalize("NFC").split(/[^\p{L}]+/u).filter((w) => w.length >= 2);
    let chon = null;
    for (const m of messages || []) {
      if (this.isFromPage(m, pageId)) continue;
      const t = String(this.messageText(m) || "");
      const tuKhach = new Set(tu(t));
      for (const c of [...mauPOS].sort((a, b) => b.length - a.length)) {
        const tuMauKhac = new Set(mauPOS.filter((x) => x !== c).flatMap(tu));
        const rieng = tu(c).filter((w) => !tuMauKhac.has(w));
        if (phang(t).includes(phang(c)) || rieng.some((w) => tuKhach.has(w))) {
          chon = c;
          break;
        }
      }
    }
    return chon;
  }

  /**
   * NHU NGUOI BAN THAT: ghi nho don dang chot (mau, size, SDT, dia chi) va chi ra MOT viec tiep theo can lam.
   * Nguoi ban khong hoi lai thu da biet, khong hoi hai thu mot luc khi khach dang tra loi tung cai.
   */
  orderProgressPrompt(pageId, messages) {
    const f = this.customerFacts(pageId, messages);
    const dong = [
      `- Màu: ${f.color || "CHƯA CHỌN"}`,
      `- Size: ${f.size ? f.size + (f.sizeFrom === "khach" ? " (khách tự chọn)" : " (tra từ số đo khách gửi)") : f.measured ? `CHƯA CHỐT — nhưng khách ĐÃ GỬI số đo: ${soDoText(f)}` : "CHƯA CÓ"}`,
      `- Số điện thoại: ${f.phone ? "ĐÃ CÓ" : "CHƯA CÓ"}`,
      `- Địa chỉ: ${f.address ? `ĐÃ CÓ ("${f.address}")` : "CHƯA CÓ"}`,
    ];
    const daChot = this.orderClosedIn(pageId, messages);
    if (!daChot && !f.color && !f.size && !f.measured && !f.phone && !f.address) return "";
    const daHuaFreeShip = (messages || []).some((m) => this.isFromPage(m, pageId) && /(hỗ trợ|tặng|được|free|em)\s*(miễn phí|free)\s*(vận chuyển|ship|phí ship)/i.test(this.messageText(m)));
    if (daHuaFreeShip) dong.push("- Phí ship: shop ĐÃ hứa MIỄN PHÍ vận chuyển cho khách này — tổng tiền KHÔNG cộng phí ship");
    const maChuLuc = String(settings.effective(pageId).defaultProduct || "").trim().toUpperCase();
    if (maChuLuc) dong.push(`- Mẫu: ${maChuLuc} (mẫu chủ lực của page) — bản chốt đơn ghi tên sản phẩm là "Đầm ${maChuLuc}", không dùng tên mô tả`);
    dong.push("- Địa chỉ phải có ĐỦ xã/phường + quận/huyện + tỉnh/thành mới được gửi bản chốt đơn; thiếu cấp nào thì hỏi cấp đó");
    // Khach nho nguoi khac nhan ("gửi con gái nhận hộ") roi gui ten + dia chi + SDT: SDT do LA SDT nhan hang (su co
    // Nguyen Thi Quyen 03/10/2026: bot xin them "số điện thoại của con gái chị")
    if (f.phone) dong.push("- SĐT khách đã gửi là SĐT nhận hàng, kể cả khi người nhận là người khác (nhận hộ) — KHÔNG xin thêm SĐT người nhận");
    let tiep;
    if (!f.size && f.measured) tiep = `báo size hợp với số đo khách đã gửi (${soDoText(f)}) theo bảng size trong hướng dẫn. TUYỆT ĐỐI KHÔNG hỏi lại chiều cao / cân nặng`;
    else if (!f.size) tiep = "hỏi chiều cao và cân nặng (hoặc size khách muốn)";
    else if (!f.color) tiep = "hỏi khách chọn màu nào";
    else if (!f.phone && !f.address) tiep = "xin số điện thoại và địa chỉ nhận hàng";
    else if (!f.phone) tiep = "xin số điện thoại";
    else if (!f.address) tiep = "xin địa chỉ nhận hàng";
    else tiep = "đủ thông tin rồi: tóm tắt lại đơn (mẫu, màu, size, giá, SĐT, địa chỉ) để khách xác nhận. Khách lấy NHIỀU MÀU thì MỖI MÀU MỘT DÒNG kèm số lượng và size, dùng đúng tên màu trong danh mục (vd \"• 1 Đen XL\" và \"• 1 Đỏ Đô XL\"), KHÔNG gộp \"màu Đen, Đỏ x 2\"";
    // Don da chot / khach da cho du thong tin quanh luc gui SDT: thoi dan khach di tiep, tra loi dung cau hoi roi dung
    if (daChot) {
      // Don chot roi: dong "CHƯA CÓ" (tin cu troi khoi cua so) chi lam AI tuong con thieu ma hoi lai -> bo
      for (let i = dong.length - 1; i >= 0; i--) if (/CHƯA (CÓ|CHỌN)/.test(dong[i])) dong.splice(i, 1);
      const daGuiTomTat = (messages || []).some((m) => this.isFromPage(m, pageId) && isOrderSummaryReply(this.messageText(m), false));
      tiep = `ĐƠN ĐÃ ĐỦ THÔNG TIN. TUYỆT ĐỐI KHÔNG hỏi thêm bất cứ thông tin nào (số đo, size, màu, SĐT, địa chỉ), KHÔNG hỏi "em lên đơn nhé?" / "chị cần hỗ trợ gì thêm không?", KHÔNG mời mua thêm. ${daGuiTomTat ? "Shop ĐÃ gửi bản chốt đơn rồi: KHÔNG gửi lại; chỉ trả lời đúng câu khách vừa hỏi trong 1–2 câu rồi dừng" : "Gửi bản tóm tắt chốt đơn MỘT lần (mẫu, màu, size, giá, SĐT, địa chỉ) để khách xác nhận, không kèm câu hỏi nào khác"}.
- Tin ngắn của khách ("Ok", "Ừ em", "Không em", "Được", tim/like…): ĐỌC CÂU SHOP VỪA GỬI NGAY TRƯỚC để hiểu khách đang trả lời điều gì rồi đáp đúng ý đó — đồng ý lên đơn/gửi hàng thì xác nhận ngắn là đơn sẽ được gửi; trả lời "không" cho câu hỏi "cần hỗ trợ thêm gì" thì chào ngắn rồi thôi; khách xác nhận một thông tin thì ghi nhận ngắn. Không đáp mẫu, không hỏi lại`;
    }
    return `

## ĐƠN ĐANG CHỐT VỚI KHÁCH NÀY (hệ thống tự đọc từ tin của khách)
${dong.join("\n")}
- VIỆC TIẾP THEO: ${tiep}.
- Nói chuyện như người bán thật: trả lời ĐÚNG câu khách vừa hỏi trước, rồi mới làm việc tiếp theo. KHÔNG hỏi lại thứ ĐÃ CÓ, KHÔNG nhắc lại nguyên văn câu mình đã gửi (bảng giá, chất liệu, chính sách…) trừ khi khách hỏi lại. Khách nói "ở trên", "gửi rồi", "nói rồi" thì xin lỗi một câu ngắn và dùng thông tin đã có.
- KHÔNG nói kiểu máy "em đã có số điện thoại / địa chỉ của mình rồi ạ": khách vừa gửi gì thì dùng luôn và làm bước tiếp theo.`;
  }

  /**
   * Bo cau bot sap gui ma NOI GAN NHU Y HET mot cau shop da gui trong hoi thoai (bang gia, chat lieu, cau xin thong
   * tin...). Nguoi ban that khong doc lai nguyen doan quang cao moi luot. Giu cau neu khach vua hoi lai dung chu de do
   * (tin cuoi cua khach chung >= 2 tu noi dung voi cau), va khong dung vao ban tom tat chot don.
   */
  dropRepeatedSentences(reply, pageId, messages) {
    const t = String(reply || "");
    if (!t.trim() || isOrderSummaryReply(t, false)) return t;
    const chuan = (x) => String(x || "").toLowerCase().normalize("NFC").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length >= 2);
    const shop = (messages || []).filter((m) => this.isFromPage(m, pageId)).slice(-12);
    const cauCu = shop.flatMap((m) => String(this.messageText(m) || "").split(/(?<=[.?!\n])/)).map(chuan).filter((w) => w.length >= 5).map((w) => new Set(w));
    if (!cauCu.length) return t;
    const khach = (messages || []).filter((m) => !this.isFromPage(m, pageId));
    const tuKhachCuoi = new Set(chuan(this.messageText(khach[khach.length - 1])).filter((w) => w.length >= 3));
    const giong = (a, b) => {
      let chung = 0;
      for (const w of a) if (b.has(w)) chung++;
      return chung / Math.max(a.size, b.size);
    };
    const bo = [];
    const giu = t.split(/(?<=[.?!\n])/).filter((c) => {
      const w = chuan(c);
      if (w.length < 5) return true;
      const set = new Set(w);
      const lap = cauCu.some((cu) => giong(set, cu) >= 0.75);
      const khachHoiLai = [...set].filter((x) => x.length >= 3 && tuKhachCuoi.has(x)).length >= 2;
      if (lap && !khachHoiLai) bo.push(c.trim());
      return !(lap && !khachHoiLai);
    });
    if (!bo.length) return t;
    log.warn(`[${pageId}] Bot lap lai cau da gui -> bo: ${bo.join(" | ").slice(0, 200)}`);
    store.bumpStat(pageId, "repeatGuard");
    return giu.join("").replace(/\n{3,}/g, "\n\n").trim();
  }

  /**
   * Bo cac cau trong tra loi dang XIN LAI thu khach da dua (SDT / dia chi / so do-size). Bo theo tung cau (tach theo
   * dau cau va xuong dong), giu nguyen phan con lai; bo het ma khong con gi thi tra "" de nhanh sau tu them cau di tiep.
   */
  /**
   * Dia chi trong ban chot don da du tinh / huyen / xa chua (cung bo tach dia chi cua bot len don). Tra ve cau HOI lai
   * dung cap con thieu, hoac null neu da du / khong doc duoc dong dia chi (khong biet thi khong chan).
   */
  async addressQuestionForSummary(reply, pageId) {
    const m = String(reply || "").match(/(?:địa chỉ|dia chi)\s*[:：][ \t]*([^\r\n]+)/i);
    const dc = m ? m[1].trim() : "";
    if (dc.replace(/[^a-zà-ỹ0-9]/gi, "").length < 8) return null;
    this._addrCache ||= new Map();
    let addr = this._addrCache.get(dc);
    if (!addr) {
      addr = await orderSync.resolveAddress(dc, { pageName: this.pageNames.get(pageId) });
      this._addrCache.set(dc, addr);
      if (this._addrCache.size > 500) this._addrCache.delete(this._addrCache.keys().next().value);
    }
    let thieu = "";
    if (!addr.province) thieu = "quận/huyện và tỉnh/thành phố";
    else if (!addr.district || addr.ambiguous) thieu = "quận/huyện";
    else if (!addr.commune) thieu = "xã/phường";
    if (!thieu) return null;
    const xung = settings.effective(pageId).customerTitle || "chị";
    return `Dạ ${xung} cho em xin thêm ${thieu} của địa chỉ "${dc}" để shipper giao đúng chỗ, em lên đơn cho ${xung} luôn nhé ạ ❤️`;
  }

  /**
   * Shop da HUA mien phi ship trong hoi thoai ("hỗ trợ miễn phí vận chuyển") ma ban chot don van ghi "+ 25.000đ phí vận
   * chuyển = 524.000đ" -> sua dong tong thanh tien hang + "miễn phí vận chuyển" (su co Thu Thuy 02/10/2026).
   */
  /**
   * Ban chot don phai ghi MA mau ("Đầm Q005"), khong phai ten mo ta trong kich ban page ("Đầm xếp ly eo tay lỡ") —
   * chu shop 02/10/2026: nhan vien / bot len don doi chieu theo ma. Ban chot chua co ma nao ma page co mau chu luc
   * -> thay ten o dong san pham dau tien bang ten danh muc cua ma do (khong co dau phan cach thi them dong "Mẫu:").
   */
  productCodeInSummary(reply, pageId) {
    const t = String(reply || "");
    if (/\b[A-Z]{1,3}\d{3}\b/.test(t)) return t;
    const ma = String(settings.effective(pageId).defaultProduct || "").trim().toUpperCase();
    if (!ma) return t;
    const p = catalog.products.find((x) => String(x.code || "").toUpperCase() === ma);
    const ten = p && String(p.name || "").toUpperCase().includes(ma) ? p.name : `Đầm ${ma}`;
    const dong = t.split("\n");
    const i = dong.findIndex((d) => /^\s*[•\-*]/.test(d) && !/^\s*[•\-*]\s*(tổng|người nhận|tên|sđt|số điện thoại|địa chỉ|phí|ship|thanh toán)/i.test(d));
    if (i < 0) return t;
    const m = dong[i].match(/^(\s*[•\-*]\s*)(.+?)(\s+[–—-]\s+|\s+(?=màu\s)|\s+(?=size\s))(.*)$/i);
    if (m && !/^\d/.test(m[2])) dong[i] = `${m[1]}${ten}${m[3]}${m[4]}`;
    else dong.splice(i, 0, `• Mẫu: ${ten}`);
    log.info(`[${pageId}] Ban chot don khong ghi ma mau -> dung ${ma}`);
    return dong.join("\n");
  }

  keepFreeShipPromise(reply, pageId, messages) {
    const t = String(reply || "");
    const daHua = (messages || []).some((m) => this.isFromPage(m, pageId) && /(hỗ trợ|tặng|được|free|em)\s*(miễn phí|free)\s*(vận chuyển|ship|phí ship)/i.test(this.messageText(m)));
    if (!daHua) return t;
    const sua = t.replace(/([\d.]{5,})\s*đ\s*\+\s*[\d.]{5,}\s*đ\s*(?:phí\s*)?(?:vận chuyển|ship)[^=\n]*=\s*[\d.]{5,}\s*đ/i, "$1đ (miễn phí vận chuyển)");
    if (sua !== t) {
      log.warn(`[${pageId}] Ban chot don cong phi ship du shop da hua mien phi -> bo phi ship`);
      store.bumpStat(pageId, "freeShipGuard");
    }
    return sua;
  }

  /**
   * Cho TRONG kieu mau "[Số điện thoại khách đã cung cấp]" / "[Địa chỉ khách đã cung cấp]" ma AI de lai trong ban
   * chot don: dien bang SDT / dia chi THAT khach da go; khong co thi bo ca dong do. Khong bao gio gui ngoac vuong cho khach.
   * Su co 30/09/2026 (Son Ngoc Nguyen, Linh Tay Luxury): khach da gui SDT + dia chi, bot gui ban chot co hai cho trong.
   */
  fillPlaceholders(reply, pageId, messages) {
    const t = String(reply || "");
    if (!/\[(?!\[)[^\]\n]{2,80}\](?!\])/.test(t)) return t;
    const loi = (messages || []).filter((m) => !this.isFromPage(m, pageId)).map((m) => this.messageText(m));
    const sdt = loi.flatMap((x) => phonesInText(x)).pop() || "";
    const f = this.customerFacts(pageId, messages);
    const out = t
      .split("\n")
      .map((dong) =>
        dong.replace(/(?<!\[)\[([^\]\n]{2,80})\](?!\])/g, (all, ben) => {
          if (/^(IMG|HANDOFF)/i.test(ben)) return all;
          if (/điện thoại|sđt|sdt|số đt/i.test(ben)) return sdt || "\u0000";
          if (/địa chỉ/i.test(ben)) return f.address || "\u0000";
          if (/tên/i.test(ben)) return "\u0000";
          return "\u0000";
        }),
      )
      .filter((dong) => !dong.includes("\u0000"))
      .join("\n");
    log.warn(`[${pageId}] Bot de cho trong [..] trong cau tra loi -> dien bang thong tin that / bo dong`);
    store.bumpStat(pageId, "placeholderGuard");
    return out;
  }

  /**
   * Bo cau KHAI BAO kieu may "em đã có số điện thoại của mình rồi ạ" / "em đã có địa chỉ của mình rồi ạ": nguoi ban
   * that khong doc lai thu khach vua dua, ho lam buoc tiep theo. Chi bo cau dung rieng; loi chao dung truoc ("Dạ chị
   * X ơi,") duoc giu. Bo het thi tra "" de nhanh sau tu them cau di tiep.
   */
  dropAnnouncedFacts(reply, pageId) {
    const t = String(reply || "");
    const KHAI = /(?:^|,\s*)(?:dạ\s+(?:vâng\s+)?)?em\s+(?:(?:đã|đã được|vừa)\s+)?(?:có|nhận|nhận được|ghi nhận|lưu)(?:\s+được)?\s+(?:đủ\s+)?(?:số điện thoại|sđt|sdt|địa chỉ|thông tin|số đo)[^.?!\n]*?(?:rồi|nhé|nha)?\s*(?:ạ|nhé|nha)?\s*[.!]?\s*$/i;
    const parts = t.split(/(?<=[.!?\n])/);
    let doi = false;
    const out = parts.map((c) => {
      const m = c.match(KHAI);
      if (!m) return c;
      doi = true;
      const truoc = c.slice(0, m.index).trim();
      // "Dạ chị Liên ơi, em đã có địa chỉ ... rồi ạ." -> giu "Dạ chị Liên ơi," noi vao cau sau
      return truoc ? truoc.replace(/,?$/, ", ") : c.endsWith("\n") ? "\n" : "";
    });
    if (!doi) return t;
    store.bumpStat(pageId, "announceGuard");
    let r = out.join("").replace(/,\s*\n/g, ", ").replace(/\n{3,}/g, "\n\n").trim();
    // Loi chao dung mot minh ("Dạ chị Liên ơi,") khong phai cau tra loi
    if (/^[^.?!\n]{0,40},$/.test(r)) r = "";
    return r;
  }

  dropAlreadyGivenAsks(reply, pageId, messages) {
    const t = String(reply || "");
    if (!t.trim()) return t;
    const f = this.customerFacts(pageId, messages);
    const XIN = /(xin|cho em|gửi em|gửi giúp|nhắn em|nhắn giúp|cung cấp|để lại|cho shop|báo em)/i;
    const known = [];
    if (f.phone) known.push(/(số điện thoại|sđt|sdt|số đt|số phone)/i);
    if (f.address) known.push(/(địa chỉ|dia chi|đ\/c|đc nhận)/i);
    if (f.size || f.measured) known.push(/(chiều cao|cân nặng|số đo|chiều cao cân nặng)/i);
    if (!known.length) return t;
    const parts = t.split(/(?<=[.?!\n])/);
    const bo = [];
    const giu = parts.filter((c) => {
      const hoiLai = XIN.test(c) && known.some((re) => re.test(c));
      // Cau vua xin thu da co vua xin thu CHUA co (vd "xin SDT va dia chi" ma moi co SDT) -> giu, de khach bo sung
      const conThieu = hoiLai && ((!f.phone && /(số điện thoại|sđt|sdt)/i.test(c)) || (!f.address && /địa chỉ/i.test(c)) || (!f.size && !f.measured && /(chiều cao|cân nặng)/i.test(c)));
      if (hoiLai && !conThieu) bo.push(c.trim());
      return !(hoiLai && !conThieu);
    });
    if (!bo.length) return t;
    log.warn(`[${pageId}] Bot xin lai thu khach da dua (${[f.phone && "SĐT", f.address && "địa chỉ", f.size && "size " + f.size].filter(Boolean).join(", ")}) -> bo: ${bo.join(" | ").slice(0, 200)}`);
    store.bumpStat(pageId, "askAgainGuard");
    return giu.join("").replace(/\n{3,}/g, "\n\n").trim();
  }

  /**
   * He thong da tra ra size ma bot van doi hoi lai chieu cao/can nang -> thay bang cau tra loi dung.
   * Model nho hay khong tin ket qua khi khach viet thieu don vi ("cao 165 nang 55").
   */
  /**
   * Da co DU so do cua khach (tra ra size) ma bot van xin lai chieu cao / can nang -> thay bang cau bao size.
   * Su co 2026-09-26 (Hoai Thu, Linh Tay CS1): khach gui 60kg/1m60 hai lan, bot van xin lai, khach "Do dien... k mua nua".
   */
  stopAskingMeasurementsAgain(reply, pageId, messages) {
    const t = String(reply || "");
    if (!/(xin|cho em|gửi em|nhắn em|cung cấp)[^.?!\n]{0,40}(chiều cao|cân nặng|số đo)/i.test(t)) return t;
    const r = this.sizeLookupFor(pageId, messages);
    if (r.status !== "ok") return t;
    const eff = settings.effective(pageId);
    const xung = eff.customerTitle || "chị";
    const Xung = xung[0].toUpperCase() + xung.slice(1);
    const soDo = r.h ? `cao ${(r.h / 100).toFixed(2).replace(".", "m")}, nặng ${r.w}kg` : `nặng ${r.w}kg`;
    log.warn(`[${pageId}] Bot xin lai so do du khach da gui (${soDo}) -> thay bang cau bao size ${r.size}`);
    store.bumpStat(pageId, "measureAgainGuard");
    return `Dạ em xin lỗi ${xung} ạ, em đã xem lại: ${xung} ${soDo} mặc size ${r.size} là vừa đẹp ạ ❤️ Nhận hàng được kiểm tra trước, chưa vừa shop hỗ trợ đổi size nha ${xung}.
${Xung} lấy màu nào để em lên đơn cho mình ạ?`;
  }

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
    if (/\[\[IMG:/i.test(t)) return t;
    // Khach XIN ANH o tin cuoi ("cho xem anh", "gui hinh", "co anh that k") -> luon gui anh, ke ca da gui truoc do.
    // Su co 2026-09-26 (Linh Tay CS1 chay Q005): khach xin anh ma bot chi tra loi chu.
    const tinKhach = (messages || []).filter((m) => !this.isFromPage(m, pageId));
    const cuoiKhach = String(this.messageText(tinKhach[tinKhach.length - 1]) || "");
    const khachXinAnh = /(ảnh|hình|hinh|anh thật|video|clip)/i.test(cuoiKhach) && /(xem|gửi|gui|cho|có|co|xin|đâu|dau|coi)/i.test(cuoiKhach);
    // Khoi bao gia, hoac bot noi "em gui chi anh" ma quen ma anh
    if (!khachXinAnh && !/GIÁ NIÊM YẾT|Giá ưu đãi|GIÁ XẢ|giá xả|gửi (chị|anh|mình|c|a) (ảnh|hình)|gửi ảnh|gửi hình/i.test(t)) return t;
    const eff = settings.effective(pageId);
    if (eff.sendProductImages === false) return t;
    // Da gui anh trong hoi thoai roi thi thoi (tranh gui lai moi lan nhac gia) - tru khi khach vua xin anh
    const daCoAnh = (messages || []).some((m) => this.isFromPage(m, pageId) && imageUrls(m.attachments).length);
    if (daCoAnh && !khachXinAnh) return t;
    const ma =
      t.match(/\bQ\d{3}\b/)?.[0] ||
      String(eff.defaultProduct || "").trim() ||
      String(eff.extraPrompt || "").match(/(?:chủ lực|mặc định)[^\n]{0,60}?\b(Q\d{3})\b/i)?.[1];
    const test = this.scopedTestProduct(pageId);
    if (!ma || !(catalog.products.some((p) => String(p.code || "").toUpperCase() === ma.toUpperCase()) || (test && test.code === ma.toUpperCase()))) return t;
    log.info(`[${pageId}] Khoi bao gia khong kem anh -> tu them [[IMG:${ma}]]`);
    return `${t}\n[[IMG:${ma}]]`;
  }

  sizeHintFor(pageId, messages) {
    const eff = settings.effective(pageId);
    const chart = parseChart(eff.sizeChart);
    if (!chart) return "";
    // Tim so do tren MOI tin khach da tai (khong chi 8 tin cuoi): su co 2026-09-26 (Hoai Thu, Linh Tay CS1)
    // khach nhan nhieu tin ngan ("Dung vay", "Co le"...) day tin 60kg/1m60 ra khoi 8 tin -> bot hoi lai 3 lan, khach bo di.
    const tatCa = (messages || []).filter((m) => !this.isFromPage(m, pageId)).reverse();
    const list = tatCa.slice(0, 8);
    let h = null, w = null;
    for (const m of tatCa) {
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
    // Khach da cho du thong tin quanh luc gui SDT (ho so don cua hoi thoai dang xu ly) = don da chot
    if (this.scopedOrderInfo(pageId)) return true;
    const eff = settings.effective(pageId);
    const dau = String(eff.afterOrderText || "").trim().slice(0, 25);
    return (messages || [])
      .filter((m) => this.isFromPage(m, pageId))
      .some((m) => {
        const t = this.messageText(m);
        // "em chốt đơn đầm Q002 màu Đỏ size M cho chị" cung la chot don (truoc chi bat "em chốt đơn cho" -> Bui Phuong Vy 02/10)
        if (/em (đã )?chốt đơn\b[^.?!\n]{0,80}\bcho\b|đơn của (anh|chị) (đã|em)|kiểm tra giúp em thông tin/i.test(t)) return true;
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
    // Cau moi chot / moi mua them ma model hoc lai tu lich su ("Em lên đơn gửi hàng cho chị luôn nhé ạ?") cung bo:
    // don da chot roi thi hoi lai la lam phien (Bui Phuong Vy 02/10/2026: cau nay lap 6 lan)
    const HOI_CHOT = /(lên đơn|chốt đơn|gửi hàng)[^.?!\r\n]{0,40}(luôn|nhé|nha|không|chưa)[^.?!\r\n]*\?|cần em (tư vấn|hỗ trợ)[^.?!\r\n]{0,30}(gì|không)[^.?!\r\n]*\?/i;
    // Luot GIU DON (khach vua xin huy lan dau): cau moi giu don / gui hang la cau can thiet, khong cat
    const giuDon = this.cancelStage(pageId, messages) === "retain";
    const bo = (c) => XIN.test(c) || (!giuDon && HOI_CHOT.test(c));
    if (!bo(text)) return reply;
    const cau = text.split(/(?<=[.?!\r\n])\s*/).filter((c) => c.trim() && !bo(c));
    const xung = settings.effective(pageId).customerTitle || "chị";
    const con = cau.join(" ").trim();
    log.warn(`[${pageId}] Don da chot ma bot con doi xin thong tin / hoi chot lai -> da cat cau do`);
    // Don da chot: khong gan them cau hoi nao (chu shop 02/10/2026: du thong tin thi ket thuc hoi thoai som)
    return con || `Dạ vâng ạ, em đã ghi nhận đủ thông tin của ${xung} rồi ạ ❤️`;
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
      /(cho em xin|cho em biết|anh cho em|chị cho em|mình cho em|nhắn em chiều cao|chiều cao và cân nặng|chiều cao cân nặng|size phù hợp cho mình|có muốn|muốn lấy|được không|không ạ|chưa ạ|chọn màu nào|lấy màu nào|mấy bộ|mấy chiếc|mình chốt|kiểm tra giúp em|kiểm tra lại giúp em)/.test(duoi);
    if (daCoHoi) return reply;
    // Ban chot don da xong (co dong Nguoi nhan / Tong / Dia chi): khong gan them cau xin gi nua — su co 30/09/2026
    // (Son Ngoc Nguyen): ban chot don size XL ket thuc bang "Chị cho em xin chiều cao và cân nặng..."
    if (isOrderSummaryReply(text, false)) return reply;

    const eff = settings.effective(pageId);
    const xung = eff.customerTitle || "chị";
    const loiKhach = (messages || [])
      .filter((m) => !this.isFromPage(m, pageId))
      .map((m) => this.messageText(m))
      .join(" ");
    const b = parseBody(loiKhach);
    // Da biet size khi khach gui du so do, HOAC khach tu chon size, HOAC bang size tra ra duoc tu so do (bang dam chi can
    // can nang). Truoc day chi xet "du ca chieu cao lan can nang" -> khach chon "size XL" van bi xin lai (Ta Thuy 29/09).
    const f = this.customerFacts(pageId, messages);
    const coSoDo = (b.heightCm !== null && b.weightKg !== null) || !!f.size || f.measured;
    const coSdt = f.phone;

    // Don da chot xong: khong ep them cau hoi nua, neu khong bot se hoi "can ho tro them gi" mai khong dut
    if (this.orderClosedIn(pageId, messages)) return reply;
    const Xung = xung[0].toUpperCase() + xung.slice(1);
    let hoi;
    if (!coSoDo) hoi = `${Xung} cho em xin chiều cao và cân nặng để em tư vấn size chuẩn cho mình nhé ạ?`;
    else if (!coSdt && !f.address) hoi = `${Xung} cho em xin số điện thoại và địa chỉ để em lên đơn gửi hàng cho mình nhé ạ?`;
    else if (!coSdt) hoi = `${Xung} cho em xin số điện thoại để em lên đơn gửi hàng cho mình nhé ạ?`;
    else if (!f.address) hoi = `${Xung} cho em xin địa chỉ nhận hàng để em lên đơn cho mình nhé ạ?`;
    else hoi = `Em lên đơn gửi hàng cho ${xung} luôn nhé ạ?`;
    log.info(`[${pageId}] Cau tra loi chua co cau hoi -> tu them: ${hoi}`);
    return `${text}\n${hoi}`;
  }

  buildSystemPrompt(pageId, { customerName, type, commentMode, saleActive = false, adBot }) {
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
    // Bot rieng cua camp test (khach bam quang cao nao): mac dinh lay tu pham vi luot xu ly, chat thu truyen tuong minh
    const scoped = aiScope.getStore();
    const botCamp = adBot !== undefined ? adBot : scoped && String(scoped.adBotPageId) === String(pageId) ? scoped.adBot : null;
    prompt += adBotPromptBlock(botCamp);
    // Thoi gian giao hang: MOT cho duy nhat (settings.deliveryDays), de len moi con so khac trong prompt chung / rieng
    prompt += `

## THỜI GIAN GIAO HÀNG (shop vừa cập nhật — dùng con số này, bỏ mọi con số khác trong hướng dẫn)
- Giao hàng toàn quốc ${settings.deliveryDays()} ngày.`;
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
      adIds: extractAdIds(conv),
    });
  }

  /**
   * Chuyen tin nhan Pancake -> lich su cho Gemini.
   * Neu VISION_ENABLED, tai toi da VISION_MAX_IMAGES anh gan nhat cua khach de Gemini xem.
   */
  /** Ghi don nhap POS tu mot hoi thoai bat ky (nut trong app / tro ly AI). Doc lai toi da 60 tin. */
  async syncOrderForConversation(pageId, conversationId) {
    // Luot trich don bam tay cung la tien cua CHINH hoi thoai do
    return aiScope.run({ pageId: String(pageId), conversationId: String(conversationId) }, () => this._syncOrderForConversation(pageId, conversationId));
  }

  async _syncOrderForConversation(pageId, conversationId) {
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

  /** Mau test moi cua camp dang ap cho luot xu ly (bot rieng theo quang cao), hoac null. */
  scopedTestProduct(pageId) {
    const s = aiScope.getStore();
    if (!s?.adBot?.test) return null;
    if (pageId !== undefined && String(s.adBotPageId) !== String(pageId)) return null;
    return s.adBot.test;
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
      // Mau test moi (chua co tren POS): anh lay tu bo anh ERP gui sang theo mau, khong tu danh muc
      const testList = isAll ? null : testImageRefs(this.scopedTestProduct(), ref);
      const list = testList || (isAll ? catalog.referenceImages(10000).map((r) => r.url) : catalog.findImages(ref, config.maxProductImages));
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
        const img = url.startsWith("adimg:") ? adBots.readImageRef(url) : await fetchImageAsBase64(url, { maxBytes: 15 * 1024 * 1024 });
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
              this.queue.push(`${pid}:${conv.id}`, { pageId: pid, conversationId: conv.id, type: String(conv.type || type).toUpperCase(), customerName: conv.from?.name, tags: conv.tags, force, adIds: extractAdIds(conv) });
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
  /** Moi lan goi AI trong luot xu ly nay duoc tinh tien cho dung page (aicost.js). */
  processConversation(payload) {
    return aiScope.run({ pageId: String(payload.pageId), conversationId: payload.conversationId ? String(payload.conversationId) : null }, () => this._processConversation(payload));
  }

  async _processConversation({ pageId, conversationId, type = "INBOX", customerName, tags, force = false, adIds = [] }) {
    const client = this.getClient(pageId);
    if (!client) return;
    if (this.isPaused(tags, pageId)) return;
    const eff = settings.effective(pageId);
    if (!eff.enabled) return;

    const data = await client.getMessages(conversationId);
    let messages = sortChrono(data.messages); // luon cu -> moi theo inserted_at (Pancake tra thu tu khong on dinh)
    if (messages.length === 0) return;
    // Khach den tu quang cao test co bot rieng: dat vao pham vi luot xu ly -> prompt + mau mac dinh theo camp
    const adBot = adBots.resolve(pageId, conversationId, extractAdIds({ ad_ids: adIds }, data));
    const scope = aiScope.getStore();
    if (scope) Object.assign(scope, { adBot, adBotPageId: String(pageId) });
    if (adBot) log.info(`[${pageId}] ${conversationId}: khach tu quang cao ${adBot.adId} -> bot rieng "${adBot.campaignName || adBot.adName}"${adBot.productCode ? " (mau " + adBot.productCode + ")" : ""}`);

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

    // Ho so don: khach da gui SDT ma 30 tin truoc do da du thong tin -> coi nhu don da chot (thoi hoi them)
    if (type === "INBOX") await this.refreshOrderInfo(client, pageId, conversationId, messages, data);

    // Don da chot ma khach chi cam on / noi loi ket: dap 1 cau ngan roi dung, khong hoi lai, khong ton tien Gemini
    // CHI loi CAM ON moi dap mau. "Ok", "Ừ em", "Không em"… nghia tuy cau shop vua hoi (dong y len don, tu choi tu van
    // them, hay chi xa giao) -> de AI doc ngu canh ma tra loi (chu shop 02/10/2026: "tùy thuộc vào hoàn cảnh để suy luận").
    if (type === "INBOX" && this.isLoiKet(lastText) && /(cảm ơn|cám ơn|thank|tks|cam on)/i.test(lastText) && this.orderClosedIn(pageId, messages)) {
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
      // Mau test moi chua co tren POS: KHONG len don qua ca hai duong (chu shop: chi len don khi mau thang)
      if (this.scopedTestProduct(pageId)) {
        log.info(`[${pageId}] ${conversationId}: mau test moi -> khong ghi don POS`);
      } else if (this.orderBot.enabledFor(pageId) && !eff.dryRun) {
        this.orderBot.notify(pageId, conversationId, messages, customerName || "");
        if (this.orderBot.items[String(conversationId)]) this.orderBot.schedule(String(conversationId), 5000);
      } else if (eff.orderSync && orderSync.enabled && !eff.dryRun) {
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
    // Don da chot cung kem muc nay: no noi "đơn đã đủ, đừng hỏi thêm, đọc ngữ cảnh tin ngắn" (truoc day bo qua -> AI
    // khong biet don da du, hoc theo lich su ma hoi "Em lên đơn…?" mai — Bui Phuong Vy 02/10/2026)
    systemPrompt += this.orderProgressPrompt(pageId, messages);
    if (this.orderClosedIn(pageId, messages)) {
      systemPrompt += `

## ĐƠN CỦA KHÁCH NÀY ĐÃ CHỐT XONG
- Hội thoại này đã có bản chốt đơn. TUYỆT ĐỐI KHÔNG hỏi lại chiều cao, cân nặng, size, số điện thoại hay địa chỉ nữa.
- Khách nhắn thêm thì chỉ xác nhận ngắn gọn, ghi nhận yêu cầu và cảm ơn.
- Khách chê PHÍ SHIP hoặc đòi bớt SAU khi chốt ("vẫn có ship à", "ai tính ship", "có ship thì không lấy"): áp dụng ngay quy trình giảm giá của page (miễn phí ship trước), nêu lại tổng mới, mời chốt. TUYỆT ĐỐI KHÔNG hỏi "giữ đơn hay lên combo", KHÔNG đề nghị hủy đơn.
- Nếu khách yêu cầu đổi ngày giao, đổi địa chỉ, đổi size hay thay đổi khác về đơn: xác nhận đã ghi nhận rồi thêm [[HANDOFF]] để nhân viên xử lý. (Khách xin HỦY đơn: làm theo mục "KHÁCH XIN HỦY ĐƠN" nếu có.)
- Khách chỉ cảm ơn, nói ok, chào xã giao: đáp lại ĐÚNG MỘT câu ngắn rồi dừng. TUYỆT ĐỐI KHÔNG hỏi \"cần em hỗ trợ thêm gì không\" nữa, không mời chào thêm, không kéo dài hội thoại.`;
    }

    // Khach xin huy don: lan dau hoi ly do + giu don, xin lan nua moi ghi nhan huy (chu shop 02/10/2026)
    const huyDon = type === "INBOX" ? this.cancelStage(pageId, messages) : null;
    if (huyDon === "retain") {
      log.info(`[${pageId}] ${conversationId}: khach xin huy don lan dau -> hoi ly do, giu don`);
      store.bumpStat(pageId, "cancelRetain");
      systemPrompt += `

## KHÁCH XIN HỦY ĐƠN (lần đầu) — GIỮ ĐƠN, CHƯA ĐƯỢC XÁC NHẬN HỦY
- Lượt này TUYỆT ĐỐI KHÔNG nói "em ghi nhận hủy đơn", KHÔNG thêm [[HANDOFF]]. Người bán thật sẽ hỏi lý do và cố giữ khách.
- Đọc lại hội thoại: nếu SHOP đã làm sai (hứa miễn ship mà bản chốt vẫn cộng ship, báo giá lệch nhau, hỏi lại thông tin khách đã cho, gửi sai size/màu) thì mở đầu bằng lời xin lỗi ĐÚNG lỗi đó và SỬA NGAY (vd nêu lại tổng tiền đã miễn ship).
- Hỏi nhẹ nhàng MỘT câu lý do (giá / phí ship, lo size không vừa, đổi ý màu/mẫu, hay lý do khác).
- Lý do (hoặc ngữ cảnh cho thấy) là GIÁ / PHÍ SHIP: đưa ngay nấc ưu đãi KẾ TIẾP trong quy trình giảm giá của page (chưa miễn ship thì miễn ship trước; đã miễn ship thì nấc sau), nêu tổng mới. Không nhảy cóc, không xuống dưới giá sàn, chỉ dùng mức có trong hướng dẫn; page không có quy trình giảm giá thì KHÔNG tự giảm.
- Lo size / chất lượng: nhắc được kiểm hàng trước khi nhận, không ưng không lấy, hỗ trợ đổi size.
- Chính tin hủy đã nêu lý do cá nhân KHÔNG đổi được (đặt nhầm, đã mua chỗ khác, không có ai nhận, người nhà không cho): không thuyết phục, xác nhận đã ghi nhận hủy, cảm ơn và thêm [[HANDOFF]].
- 2–3 câu, giọng chân thành, không trách khách, kết thúc bằng câu mời giữ đơn.`;
    } else if (huyDon === "accept") {
      systemPrompt += `

## KHÁCH VẪN XIN HỦY ĐƠN (đã hỏi lý do / đưa ưu đãi rồi)
- Tôn trọng quyết định, KHÔNG thuyết phục thêm, KHÔNG đưa thêm ưu đãi. Xác nhận ngắn đã ghi nhận hủy đơn, cảm ơn khách, chúc khách một ngày vui vẻ, rồi thêm [[HANDOFF]] để nhân viên hủy đơn trên hệ thống.`;
    }

    // Khach da co don / hoi "gui hang chua, bao gio nhan": dua trang thai don THAT tren POS vao prompt
    // (truoc day bot chi noi chung chung "gui toan quoc N ngay" -> khach buc, su co Loan Hoang 2026-09-15)
    if (type === "INBOX" && orderSync.enabled && (this.orderClosedIn(pageId, messages) || this.isOrderStatusQuestion(lastText))) {
      const sdtKhach = messages.filter((m) => !this.isFromPage(m, pageId)).map((m) => this.messageText(m)).join(" ").replace(/[.\s-]/g, "");
      const phones = [...(data.conv_phone_numbers || []), ...(data.recent_phone_numbers || []), ...(sdtKhach.match(/(?<!\d)0\d{9}(?!\d)/g) || [])];
      const orders = await this.recentOrdersCached(conversationId, phones);
      if (orders.length) {
        systemPrompt += `\n\n## ĐƠN HÀNG CỦA KHÁCH TRÊN HỆ THỐNG POS (dữ liệu thật, hãy dùng để trả lời)\n${orders.map((o) => "- " + describeOrder(o)).join("\n")}\n- Khách hỏi đã gửi chưa / bao giờ nhận / đơn tới đâu: trả lời ĐÚNG theo trạng thái trên (nêu trạng thái, đơn vị vận chuyển, mã vận đơn, ngày gửi), TUYỆT ĐỐI không nói chung chung "giao toàn quốc ${settings.deliveryDays()} ngày". Trả lời 1–2 câu, không hỏi lại, không mời mua thêm.\n- Đơn "Đã gửi hàng"/"Đang giao": nhắc khách để ý điện thoại, bưu tá sẽ gọi. Đơn "Giao không thành công"/"Đang hoàn": xin lỗi, thêm [[HANDOFF]] để nhân viên xử lý.`;
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
        // Chi noi "khong co quyen giam them" khi khach DANG doi giam. Su co 30/09/2026 (Son Ngoc Nguyen): khach chi xac
        // nhan "chốt giá 299k" / phan nan bot doc khong ky ma nhan cau tu choi giam gia — lac de, khach buc.
        const xung = eff.customerTitle || "chị";
        const doiGiam = /(giảm|bớt|bot gia|rẻ hơn|re hon|đắt|dat qua|mắc|bớt cho|fix|thương lượng|giá tốt hơn)/i.test(this.messageText([...messages].reverse().find((m) => !this.isFromPage(m, pageId)) || {}));
        reply = doiGiam
          ? `Dạ giá này là ưu đãi tốt nhất bên em rồi ạ, em không có quyền giảm thêm. Để em chuyển nhân viên hỗ trợ ${xung} ngay nhé ❤️ [[HANDOFF]]`
          : `Dạ em xin phép kiểm tra lại giá chính xác cho ${xung} rồi báo ${xung} ngay nhé ❤️ [[HANDOFF]]`;
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
    // Chan chot don khi DIA CHI chua du tinh / huyen / xa (su co 02/10/2026, Thu Thuy - Linh Tay Luxury CS1: khach ghi
    // "Số nhà 99 /40 Đường 8 phuong long phước" — "Long Phước" co o nhieu tinh; bot gui ban chot don, bot len don khong
    // xac dinh duoc tinh -> don nam "thieu thong tin"). Hoi dung cap con thieu thay vi chot.
    if (isOrderSummaryReply(reply, false) && orderSync.enabled) {
      const hoi = await this.addressQuestionForSummary(reply, pageId).catch(() => null);
      if (hoi) {
        log.warn(`[${pageId}] ${conversationId}: ban chot don co dia chi chua du cap -> hoi lai: ${hoi}`);
        store.bumpStat(pageId, "addressGuard");
        reply = hoi;
      }
    }
    // Shop DA hua mien phi ship ma ban chot don van cong phi ship -> bo phi ship trong ban chot (giu loi hua voi khach)
    if (isOrderSummaryReply(reply, false)) reply = this.keepFreeShipPromise(reply, pageId, messages);
    if (isOrderSummaryReply(reply, false)) reply = this.productCodeInSummary(reply, pageId);
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
    if (reply && !handoff) {
      const truoc = reply;
      reply = this.fillPlaceholders(reply, pageId, messages);
      reply = this.dropAlreadyGivenAsks(reply, pageId, messages);
      reply = this.dropAnnouncedFacts(reply, pageId);
      reply = this.dropRepeatedSentences(reply, pageId, messages);
      if (!reply.trim() && truoc.trim()) {
        const f = this.customerFacts(pageId, messages);
        if (f.measured && !f.size) {
          // Bot chi biet xin lai so do ma he thong khong tra duoc size -> bao nhan vien chot size, khong de khach cho ngo
          reply = `Dạ em ghi nhận số đo ${soDoText(f)} của ${eff.customerTitle || "chị"} rồi ạ, em kiểm tra size chuẩn rồi báo ${eff.customerTitle || "chị"} ngay nhé ❤️`;
          handoff = true;
        } else reply = `Dạ em ghi nhận đủ thông tin của ${eff.customerTitle || "chị"} rồi ạ ❤️`;
      }
    }
    if (reply) reply = this.stopAskingMeasurementsAgain(reply, pageId, messages);
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
    if (reply) reply = this.fixDeliveryDays(reply);
    // Moi tin phai ket thuc bang mot cau hoi de dan khach di tiep; bot hay quen nen tu them
    if (reply && !handoff && !daChaoChotDon) reply = this.ensureEndsWithQuestion(reply, pageId, messages);
    const nImages = history.reduce((n, h) => n + (h.images?.length || 0), 0);
    log.info(
      `[${pageId}] Bot -> "${name}" (${Date.now() - t0}ms, ${usage.totalTokenCount ?? "?"} tokens${nImages ? `, xem ${nImages} anh` : ""}${imageUrlsToSend.length ? `, gui ${imageUrlsToSend.length} anh SP` : ""})${handoff ? " [HANDOFF]" : ""}: ${reply.slice(0, 300)}`
    );

    // Khach nhan THEM trong luc bot dang soan (vd gui dia chi roi 20 giay sau gui SDT) -> cau tra loi nay da cu, gui ra
    // se xin lai dung thu khach vua gui (Ta Thuy 29/09: gui SDT xong bot van "cho em xin so dien thoai"). Bo cau nay,
    // de luot xu ly ke tiep doc ca tin moi roi tra loi mot lan.
    if (type === "INBOX" && !eff.dryRun) {
      try {
        const fresh = sortChrono((await client.getMessages(conversationId)).messages);
        const cuoiKhach = [...fresh].reverse().find((m) => !this.isFromPage(m, pageId));
        if (cuoiKhach && cuoiKhach.id !== last.id && parseTs(cuoiKhach.inserted_at) > parseTs(last.inserted_at)) {
          log.info(`[${pageId}] ${conversationId}: khach vua nhan them trong luc bot soan -> bo cau tra loi cu, xu ly lai voi tin moi`);
          store.bumpStat(pageId, "staleReplyDropped");
          this.queue.push(`${pageId}:${conversationId}`, { pageId, conversationId, type, customerName: name });
          return;
        }
      } catch (e) {
        log.warn(`[${pageId}] Khong kiem tra lai duoc tin moi truoc khi gui (${e.message}) -> gui nhu cu`);
      }
    }

    store.bumpStat(pageId, "replies");
    if (handoff) store.bumpStat(pageId, "handoffs");
    // SDT khach da go trong hoi thoai bot dang phu trach — mau so cua "chi phi AI / 1 SDT"
    for (const m of messages) {
      if (this.isFromPage(m, pageId)) continue;
      for (const ph of phonesInText(this.messageText(m))) store.addPhone(pageId, ph, parseTs(m.inserted_at));
    }
    if (type === "INBOX" && !this.scopedTestProduct(pageId)) this.orderBot.notify(pageId, conversationId, messages, name);
    store.recordReply(pageId, { conversationId, customerName: name, question: this.messageText(last).slice(0, 200), reply: reply.slice(0, 500), handoff, dryRun: eff.dryRun, adId: adBot?.adId || undefined });
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
    // Mau test moi chua co tren POS: KHONG ghi don qua ca hai duong (chu shop: chi len don khi mau thang) — nhan vien lo tu ban tom tat
    if (this.scopedTestProduct(pageId)) {
      // khong lam gi
    } else if (isOrderSummaryReply(reply, handoff) && type === "INBOX" && this.orderBot.enabledFor(pageId)) {
      // Bot len don doc lap nhan viec: kiem ngay (khong doi 1 phut) vi bot tu van vua tom tat chot don
      this.orderBot.notify(pageId, conversationId, messages, name);
      if (this.orderBot.items[String(conversationId)]) this.orderBot.schedule(String(conversationId), 5000);
    } else if (isOrderSummaryReply(reply, handoff) && type === "INBOX" && eff.orderSync && orderSync.enabled) {
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
