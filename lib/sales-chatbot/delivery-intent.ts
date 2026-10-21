/**
 * ═══════════ HỎI LỊCH GIAO ≠ HỎI TRẠNG THÁI ĐƠN — HÀM THUẦN (P0 #855, ca 16/10/2026 HSLC) ═══════════
 *
 * Sự cố: khách đã lên đơn 1kg chả cá thu hỏi «Hôm nào có hàng?». Lời nhắc dồn MỌI câu hỏi về đơn vào `get_order_status` rồi dặn
 * «nói ĐÚNG status», nên AI trả câu TRẠNG THÁI «Shop đã nhận đơn — chưa có thông tin vận chuyển» cho một câu hỏi KHI NÀO. Câu ấy
 * đúng nhưng vô dụng: khách hỏi giờ giao, nhân viên Page phải vào trả lời «Chiều nay giao ạ».
 *
 * Tệp này tách hai ý định và quyết câu trả lời cho câu hỏi lịch giao CHỈ từ dữ kiện THẬT của ERP:
 *  · `classifyDeliveryQuestion` — DELIVERY_TIME (kèm sắc thái TODAY · TOMORROW · URGENT · GENERIC) · ORDER_STATUS · `null`.
 *  · `deliveryTimeAnswer` — có căn cứ (chứng từ ĐVVC: bưu tá đang giao / đã giao / ETA của ĐVVC đọc được; ngày hẹn giao đã ghi
 *    trên đơn; phiếu giao ký nhận của đơn ERP) ⇒ câu ngắn trực tiếp. Không có ⇒ KHÔNG bịa giờ, KHÔNG đọc câu trạng thái thay giờ
 *    giao: câu «em báo nhân viên xác nhận giờ giao» + chuyển nhân viên (lý do «Hỏi lịch giao — <ý khách>»).
 *  · Nhân viên đã nói lịch giao trong hội thoại (tin `[Shop đã nhắn] …`) ⇒ AI KHÔNG nói khác, KHÔNG biến câu chữ ấy thành lịch giao
 *    chính thức — chuyển về nhân viên đã hẹn.
 *  · `deliveryReplyViolation` — chốt chặn cho chữ model: tin khách cuối là DELIVERY_TIME mà bản nháp chỉ là câu trạng thái «chưa có
 *    thông tin vận chuyển», hoặc hứa «hôm nay / chiều nay / mai giao» khi máy chủ không có căn cứ ⇒ vi phạm.
 *
 * Không đọc / ghi CSDL. Không kết luận kết quả đơn (`ORDER_OUTCOME` vẫn là nguồn duy nhất); không suy «đã giao» từ tiền / COD.
 */
import { adminPlaceNamesFolded, foldVnText } from "@/lib/address/vn-address";
import { NO_SHIPMENT_PHRASE } from "@/lib/sales-chatbot/order-status-shared";
import { looksLikeDeliveryAddress, looksLikeStreetFragment, parseCustomerAddress, withoutPhones } from "@/lib/address/customer-address";
import { foldVi } from "@/lib/sales-chatbot/text";

export type DeliveryNuance = "TODAY" | "TOMORROW" | "URGENT" | "GENERIC";
export type DeliveryQuestion = { intent: "DELIVERY_TIME"; nuance: DeliveryNuance } | { intent: "ORDER_STATUS"; nuance: null };

/** Câu nói với khách khi máy chủ KHÔNG có lịch giao đã xác minh. */
export const DELIVERY_HANDOFF_TEXT = "Dạ em báo nhân viên xác nhận giờ giao cho mình ngay ạ.";
/** Câu trạng thái chung của `customerOrderStatus` khi đơn không vận đơn — KHÔNG được dùng làm câu trả lời cho câu hỏi lịch giao. */
export const GENERIC_STATUS_PHRASE = NO_SHIPMENT_PHRASE;
/** Tiền tố tin phía shop trong lịch sử (= `SHOP_SAID` của engine.ts; bài kiểm so hai giá trị). */
export const DELIVERY_SHOP_SAID_PREFIX = "[Shop đã nhắn]";

/**
 * Chuẩn hoá trước khi gấp dấu — SO KHỚP CÓ DẤU cho từ mơ hồ: các từ MẤT NGHĨA khi bỏ dấu được thay bằng một mã riêng để không lẫn
 * với từ chỉ lịch giao: «nhắn» ≠ «nhận», «xác nhận» không phải «nhận hàng», «gặp» ≠ «gấp», «tôi» ≠ «tới», «tối» (buổi tối) ≠ «tới»,
 * «đen» (màu) ≠ «đến», «mãi» / «khuyến mãi» / «khuyến mại» ≠ «mai» (ngày mai), «nhân viên» không phải «nhận». Câu gõ KHÔNG DẤU hoàn
 * toàn vẫn mơ hồ ⇒ giữ cách cũ, chỉ loại thêm «khuyen mai» / «xac nhan». Dùng chung cho câu khách và chữ model (`deliveryReplyViolation`).
 */
/*
  «MAI» TRONG TÊN NƠI KHÔNG PHẢI NGÀY MAI (P0 21/10/2026, HSLC #F12342D4): «… đường Lĩnh Nam, Hoàng Mai» có động từ «về / gửi / giao» và
  chữ «mai» trần ⇒ bộ đọc ra «giao NGÀY MAI», bot nhắn «em đã nhận lời dặn giờ giao» và ghi một lời hẹn giao giả vào đơn. Tên nơi lấy từ
  DANH MỤC địa giới (gồm tên cũ — `adminPlaceNamesFolded`), không gõ tay; cặp nào trùng một cụm thời gian / tiểu từ («giờ mai» — xã «Gio
  Mai»; «mai hả», «mai sao») thì KHÔNG coi là tên nơi, vì ở đó nghĩa «ngày mai» mới là nghĩa thường gặp. Thêm: «mai» đứng ngay sau giới
  từ / tiền tố nơi chốn («về Mai …», «phường Mai …») mà theo sau là một chữ tên (không phải tiểu từ / động từ giao) cũng là tên nơi.
*/
const MAI_TIME_BEFORE = new Set(["gio", "sang", "chieu", "toi", "buoitoi", "trua", "ngay", "hom"]);
const MAI_TIME_AFTER = new Set(["ha", "a", "nhe", "nha", "nhi", "em", "e", "chi", "c", "anh", "duoc", "dc", "khong", "ko", "k", "sao", "nay", "co", "giao", "ship", "gui", "nhan", "toi", "den", "ve", "phat", "sang", "chieu", "trua", "buoitoi", "nhe"]);
let placeMaiCache: RegExp | null = null;
function placeMaiRe(): RegExp {
  if (placeMaiCache) return placeMaiCache;
  const names = new Set<string>();
  for (const n of adminPlaceNamesFolded()) {
    const w = n.split(" ");
    const i = w.indexOf("mai");
    if (i < 0 || w.length < 2) continue;
    if ((i > 0 && MAI_TIME_BEFORE.has(w[i - 1])) || (i < w.length - 1 && MAI_TIME_AFTER.has(w[i + 1]))) continue;
    names.add(n);
  }
  const alts = [...names].sort((a, b) => b.length - a.length).map((n) => n.replace(/\s+/g, "\\s+"));
  placeMaiCache = alts.length ? new RegExp(String.raw`(?:^|\s)(?:${alts.join("|")})(?=\s|$)`, "g") : /$^/g;
  return placeMaiCache;
}
const PLACE_PREP_MAI_RE = new RegExp(String.raw`(\s(?:ve|o|tai|duong|pho|quan|phuong|xa|huyen|thon|xom|ngo|khu|q|p))\smai(?=\s(?!(?:${[...MAI_TIME_AFTER].join("|")})(?:\s|$))[a-z])`, "g");

function normalizeAsk(text: string): string {
  const raw = text
    .normalize("NFC")
    .toLowerCase()
    .replace(/khuyến (?:mãi|mại)/g, " khuyenmai ")
    .replace(/mãi/g, " maimai ")
    .replace(/xác nhận/g, " xacnhan ")
    .replace(/nhắn/g, " nhantin ")
    .replace(/gặp/g, " gapmat ")
    .replace(/nhân viên/g, " nhanvien ")
    .replace(/tôi/g, " toiminh ")
    .replace(/tối/g, " buoitoi ")
    .replace(/đen/g, " mauden ");
  return ` ${foldVi(raw)
    .replace(/\bkhuyen mai\b/g, "khuyenmai")
    // «đến / tới bao giờ» = «cho tới khi nào» (khuyến mãi đến bao giờ), không phải hỏi giờ giao.
    .replace(/\b(?:den|toi) (?:bao gio|khi nao|luc nao)\b/g, "denkhinao")
    .replace(/\bxac nhan\b/g, "xacnhan")
    .replace(/\bnhan vien\b/g, "nhanvien")
    .replace(/\bgui (?:tien|anh|hinh|so|dia chi|sdt|stk|lai so)\b/g, "guithongtin")
    .replace(/\bhnay\b/g, "hom nay")
    .replace(/\bbh\b/g, "bao gio")
    .replace(placeMaiRe(), " diadanh ")
    .replace(PLACE_PREP_MAI_RE, "$1 diadanh")} `;
}

const VERB = String.raw`(?:giao|ship|gui|nhan|co hang|toi|den|ve|phat|shipper|buu ta)`;
const has = (f: string, re: string) => new RegExp(String.raw`(?:^|\s)${re}(?=\s|$)`).test(f);

const WHEN = String.raw`(?:hom nao|bao gio|khi nao|luc nao|ngay nao|may gio|may ngay|may hom|bao lau|thu may|bao nhieu ngay|bao nhieu lau)`;
// «toi nay» / «toi mai» chỉ còn ở câu không dấu (câu có dấu: «tối» đã thành «buoitoi»).
const TODAY = String.raw`(?:hom nay|trong ngay|chieu nay|sang nay|trua nay|toi nay|buoitoi nay|ngay hom nay)`;
const TOMORROW = String.raw`(?:mai|ngay mai|sang mai|chieu mai|toi mai|buoitoi mai|trua mai|mot|ngay mot)`;
const URGENT_WORD = String.raw`(?:gap|hoa toc|nhanh|som|nhanh nhat|som nhat)`;
const URGENT_ALONE = String.raw`(?:can gap|hoa toc|giao gap|ship gap|gui gap)`;
const ARRIVED = String.raw`(?:co hang chua|hang (?:toi|den|ve) chua|nhan duoc hang chua|toi chua|den chua)`;
const STATUS = [
  String.raw`(?:don|hang|goi|kien)(?:\s\S+){0,4}\s(?:sao roi|toi dau|den dau|the nao roi|dau roi|ra sao|sao chua)`,
  String.raw`(?:gui|giao|ship|dong goi|len don|chuyen)(?:\s(?:hang|don|di))?(?:\scho\s(?:em|minh|chi|anh|toiminh|e|c|a))?\schua`,
  String.raw`(?:tinh trang|trang thai)\s(?:don|hang)`,
  String.raw`(?:kiem tra|check|tra)(?:\s(?:giup|dum|ho))?(?:\s(?:em|minh|chi|anh))?\s(?:don|ma van don|van don)`,
  String.raw`ma van don`,
];

/**
 * Câu khách là hỏi LỊCH GIAO (khi nào giao / nhận / có hàng · hôm nay · ngày mai · giao gấp), hỏi TRẠNG THÁI ĐƠN («đơn sao rồi»,
 * «đã gửi chưa»), hay không liên quan (`null`). Câu vừa hỏi trạng thái vừa hỏi khi nào («gửi chưa, bao giờ nhận») là LỊCH GIAO —
 * khách cần giờ giao. Gõ không dấu cũng nhận. HÀM THUẦN.
 */
export function classifyDeliveryQuestion(text: string): DeliveryQuestion | null {
  const f = normalizeAsk(text);
  if (!f.trim()) return null;
  // «toi» trong «toi nay / toi mai» (không dấu) là BUỔI TỐI, không phải «tới» — không tính làm động từ giao hàng.
  const verb = new RegExp(String.raw`\s${VERB}\s`).test(f.replace(/\s(?:toi|buoitoi)\s(?=(?:nay|mai)\s)/g, " "));
  const urgent = has(f, URGENT_ALONE) || (verb && new RegExp(String.raw`\s${URGENT_WORD}\s`).test(f));
  const today = verb && new RegExp(String.raw`\s${TODAY}\s`).test(f);
  const tomorrow = verb && new RegExp(String.raw`\s${TOMORROW}\s`).test(f);
  const when = verb && new RegExp(String.raw`\s${WHEN}\s`).test(f);
  const arrived = new RegExp(String.raw`\s${ARRIVED}\s`).test(f);
  if (urgent) return { intent: "DELIVERY_TIME", nuance: "URGENT" };
  if (today) return { intent: "DELIVERY_TIME", nuance: "TODAY" };
  if (tomorrow) return { intent: "DELIVERY_TIME", nuance: "TOMORROW" };
  if (when || arrived) return { intent: "DELIVERY_TIME", nuance: "GENERIC" };
  if (STATUS.some((re) => new RegExp(String.raw`\s${re}\s`).test(f))) return { intent: "ORDER_STATUS", nuance: null };
  return null;
}

/**
 * Tin mới nhất phía SHOP (tiền tố `[Shop đã nhắn]` — nhân viên HOẶC trả lời tự động của page; lịch sử không phân biệt hai nguồn,
 * không phải chữ bot) có nói lịch giao. HÀM THUẦN.
 */
export function staffDeliveryCommitment(shopTexts: readonly string[]): string | null {
  for (let i = shopTexts.length - 1; i >= 0; i--) {
    const t = shopTexts[i].trim();
    if (!t.startsWith(DELIVERY_SHOP_SAID_PREFIX)) continue;
    const said = t.slice(DELIVERY_SHOP_SAID_PREFIX.length).trim();
    if (classifyDeliveryQuestion(said)?.intent === "DELIVERY_TIME") return said.slice(0, 120);
  }
  return null;
}

export type DeliveryFacts = {
  question: DeliveryQuestion & { intent: "DELIVERY_TIME" };
  /** Câu khách (chữ thô) — chỉ để ghi lý do chuyển người. */
  customerText: string;
  /** `orders.stage` của đơn được hỏi. */
  orderStage: string;
  /** Đơn tạo trong ERP (`erp-…`) — phiếu giao ký nhận là chứng từ giao. */
  manual: boolean;
  /** Vận đơn ĐẠI DIỆN; `null` = ERP không có vận đơn. `carrierEvidence` = chặng dựng từ CHỨNG TỪ ĐVVC. */
  shipment: { stage: string; carrierEvidence: boolean; expectedDelivery: string | null } | null;
  /** `orders.customer_promised_at` — ngày hẹn giao đã GHI trên đơn (người / AI ghi qua đường hẹn giao, không phải câu chữ chat). */
  promisedAt: Date | null;
  /** Tồn kho cho đơn: WAITING = đơn chờ hàng · READY = đủ hàng · `null` = ERP chưa đọc (CHƯA BIẾT, không phải «đủ»). */
  stock: "WAITING" | "READY" | null;
  /** Câu PHÍA SHOP (nhân viên / trả lời tự động) đã nói về lịch giao trong hội thoại (`staffDeliveryCommitment`). */
  staffSaid: string | null;
  /** Số đơn đang sống của hội thoại (không huỷ, đã chốt) — > 1 ⇒ không biết khách hỏi đơn nào. */
  liveOrders: number;
  now: Date;
};

export type DeliveryAnswer =
  | { kind: "DIRECT"; text: string; basis: string }
  | { kind: "HANDOFF"; text: string; reason: string }
  | { kind: "NOT_APPLICABLE"; why: string };

const VN_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" });
const vnDayKey = (d: Date) => VN_DAY.format(d);
const ddmm = (key: string) => `${key.slice(8, 10)}/${key.slice(5, 7)}`;

/**
 * ETA do ĐVVC trả (`shipments.expected_delivery`, chữ tự do) ⇒ NGÀY giờ VN dạng `yyyy-mm-dd`, chỉ khi đọc được CHẮC một ngày
 * (`dd/mm/yyyy …` giờ VN hoặc ISO) và ngày ấy chưa qua. Chữ khác («1 ngày», «Trong ngày») hay ngày đã qua ⇒ `null` (không tin).
 */
export function carrierEtaDay(raw: string | null, now: Date): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  let key: string | null = null;
  const vn = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/.exec(s);
  if (vn) {
    const [d, m, y] = [Number(vn[1]), Number(vn[2]), Number(vn[3])];
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) key = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  } else if (/^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(s)) {
    const t = new Date(s.length === 10 ? `${s}T12:00:00+07:00` : s);
    if (!Number.isNaN(t.getTime())) key = vnDayKey(t);
  }
  if (!key) return null;
  const check = new Date(`${key}T12:00:00+07:00`);
  if (Number.isNaN(check.getTime()) || vnDayKey(check) !== key) return null;
  return key >= vnDayKey(now) ? key : null;
}

/**
 * Câu trả lời cho câu hỏi LỊCH GIAO — chỉ từ dữ kiện thật. HÀM THUẦN. Thứ tự:
 *  1. Đơn nháp chưa chốt ⇒ NOT_APPLICABLE (luồng bán hàng thường lo, thời gian giao theo chính sách shop).
 *  2. Nhân viên đã nói lịch giao ⇒ chuyển về nhân viên (AI không nói khác, không lấy câu chữ làm lịch chính thức).
 *  3. Nhiều đơn sống / đơn huỷ / giao lỗi · hoàn · vận đơn huỷ / đơn chờ hàng ⇒ chuyển nhân viên.
 *  4. Chứng từ ĐVVC: đã giao · bưu tá đang giao ⇒ nói đúng; đang vận chuyển + ETA đọc được ⇒ «dự kiến» (giao gấp ⇒ người).
 *  5. Đơn ERP có phiếu giao ký nhận ⇒ «shop đã giao».
 *  6. Chưa có vận đơn + ngày hẹn giao đã ghi trên đơn (chưa qua) ⇒ nói ngày hẹn (giao gấp ⇒ người).
 *  7. Còn lại ⇒ KHÔNG hứa giờ nào: «em báo nhân viên xác nhận giờ giao» + chuyển nhân viên.
 */
export function deliveryTimeAnswer(f: DeliveryFacts): DeliveryAnswer {
  const quote = f.customerText.replace(/\s+/g, " ").trim().slice(0, 120);
  const handoff = (why: string): DeliveryAnswer => ({ kind: "HANDOFF", text: DELIVERY_HANDOFF_TEXT, reason: `Hỏi lịch giao — «${quote}» (${why})` });
  if (f.orderStage === "NEW") return { kind: "NOT_APPLICABLE", why: "đơn chưa chốt" };
  // Tiền tố «[Shop đã nhắn]» gồm cả trả lời tự động ⇒ lý do TRUNG TÍNH, không khẳng định «nhân viên đã hẹn».
  if (f.staffSaid) return handoff(`shop đã nhắn lịch giao trong hội thoại: «${f.staffSaid}» — AI không nói khác`);
  if (f.liveOrders > 1) return handoff(`hội thoại có ${f.liveOrders} đơn đang mở — cần biết khách hỏi đơn nào`);
  if (f.orderStage === "CANCELLED") return handoff("đơn trong hội thoại đã huỷ");
  const urgent = f.question.nuance === "URGENT";
  const s = f.shipment;
  if (s && s.carrierEvidence) {
    if (s.stage === "DELIVERED") return { kind: "DIRECT", text: "Dạ đơn vị vận chuyển báo đơn mình đã giao thành công ạ.", basis: "chứng từ ĐVVC: đã giao" };
    if (s.stage === "OUT_FOR_DELIVERY") return { kind: "DIRECT", text: "Dạ đơn vị vận chuyển báo bưu tá đang đi giao đơn tới mình ạ, mình để ý điện thoại giúp em nhé.", basis: "chứng từ ĐVVC: bưu tá đang giao" };
    if (s.stage === "DELIVERY_FAILED" || s.stage === "RETURNING" || s.stage === "RETURNED" || s.stage === "CANCELLED") return handoff(`ĐVVC báo ${s.stage}`);
    if (s.stage === "PICKED_UP" || s.stage === "IN_TRANSIT") {
      const eta = carrierEtaDay(s.expectedDelivery, f.now);
      if (eta && !urgent) {
        const when = eta === vnDayKey(f.now) ? "trong hôm nay" : `khoảng ngày ${ddmm(eta)}`;
        return { kind: "DIRECT", text: `Dạ đơn mình đang trên đường, đơn vị vận chuyển dự kiến giao ${when} ạ.`, basis: `ETA của ĐVVC: ${s.expectedDelivery}` };
      }
      return handoff(urgent ? "khách xin giao gấp — đơn đang vận chuyển" : "đơn đang vận chuyển, ĐVVC chưa cho ngày dự kiến đọc được");
    }
  }
  if (!s && f.manual && f.orderStage === "DELIVERED") return { kind: "DIRECT", text: "Dạ shop đã giao đơn cho mình rồi ạ (có phiếu ký nhận).", basis: "phiếu giao ký nhận" };
  if (!s && f.manual && f.orderStage === "RETURNED") return handoff("lần giao trước không thành công");
  if (f.stock === "WAITING") return handoff("đơn đang chờ hàng về kho");
  if (!s && f.promisedAt) {
    // `customer_promised_at` = ngày shop GỬI theo lời khách dặn — không phải giờ hàng tới tay. Hẹn đúng hôm nay mà khách hỏi «hôm nay»
    // ⇒ giờ giao trong ngày là việc của người, không trả lời bằng ngày hẹn.
    const key = vnDayKey(f.promisedAt);
    const today = vnDayKey(f.now);
    if (urgent) return handoff("khách xin giao gấp — đơn đang có ngày hẹn gửi");
    if (key === today && f.question.nuance === "TODAY") return handoff("khách hỏi giao hôm nay — đơn hẹn gửi đúng hôm nay");
    if (key >= today) return { kind: "DIRECT", text: `Dạ shop hẹn gửi hàng cho mình ngày ${ddmm(key)} theo lời mình dặn ạ.`, basis: "ngày hẹn gửi ghi trên đơn (theo lời khách dặn)" };
    return handoff("ngày hẹn gửi trên đơn đã qua mà chưa có vận đơn");
  }
  return handoff(s ? "đã có vận đơn nhưng chưa có chứng từ ĐVVC về lịch giao" : "đơn chưa có vận đơn, chưa có lịch giao xác minh");
}

const PROMISE_TIME = String.raw`(?:hom nay|trong ngay|chieu nay|sang nay|toi nay|buoitoi nay|trua nay|ngay mai|mai|sang mai|chieu mai|buoitoi mai)`;
const PROMISE_RE = new RegExp(String.raw`(?:^|\s)${PROMISE_TIME}(?:\s\S+){0,3}\s(?:giao|toi|den|co hang|nhan|ship|phat)(?=\s|$)|(?:^|\s)(?:giao|ship|gui|toi|den|nhan duoc)(?:\s\S+){0,3}\s${PROMISE_TIME}(?=\s|$)`);
/** Các MỐC thời gian câu nói tới (đã chuẩn hoá) — để «đã có căn cứ» chỉ cho qua đúng mốc trùng. */
const promiseTimes = (f: string): Set<string> => new Set([...f.matchAll(new RegExp(String.raw`(?<=\s)${PROMISE_TIME}(?=\s)`, "g"))].map((m) => m[0]));

/**
 * CHỐT CHẶN CHỮ MODEL: tin khách cuối hỏi LỊCH GIAO mà bản nháp (a) chỉ đọc câu trạng thái «chưa có thông tin vận chuyển», hoặc
 * (b) hứa «hôm nay / chiều nay / mai giao» trong khi máy chủ không có câu trả lời trực tiếp nói đúng mốc ấy ⇒ trả lý do vi phạm
 * (người gọi thay bằng `DELIVERY_HANDOFF_TEXT` + chuyển nhân viên). `verified` = câu DIRECT máy chủ đã quyết cho lượt này (nếu có).
 * HÀM THUẦN.
 */
export function deliveryReplyViolation(lastCustomerText: string, reply: string, verified: string | null = null): string | null {
  if (classifyDeliveryQuestion(lastCustomerText)?.intent !== "DELIVERY_TIME") return null;
  const r = reply.normalize("NFC");
  if (r.includes(GENERIC_STATUS_PHRASE) || foldVi(r).includes(foldVi(GENERIC_STATUS_PHRASE))) return "Khách hỏi lịch giao — bản nháp chỉ đọc câu trạng thái «chưa có thông tin vận chuyển»";
  const fr = normalizeAsk(r);
  if (!PROMISE_RE.test(fr)) return null;
  // Căn cứ chỉ cho qua ĐÚNG mốc máy chủ đã nói («dự kiến giao trong hôm nay» không bảo lãnh «chiều nay» hay «mai»).
  const allowed = verified ? promiseTimes(normalizeAsk(verified)) : new Set<string>();
  if ([...promiseTimes(fr)].some((t) => !allowed.has(t))) return "Khách hỏi lịch giao — bản nháp hứa mốc giao (hôm nay / ngày mai) mà máy chủ không có căn cứ";
  return null;
}

type TurnBlock = { type: string; text?: string; content?: string };

/**
 * Câu DIRECT máy chủ đã quyết trong LƯỢT hiện tại (`get_order_status` → `delivery_answer.say`) — căn cứ cho `deliveryReplyViolation`.
 * Đọc ngược lịch sử của lượt tới tin KHÁCH gần nhất (tin `user` có chữ); kết quả công cụ của lượt cũ không phải căn cứ. HÀM THUẦN.
 */
export function turnDeliverySay(history: readonly { role: string; content: readonly TurnBlock[] }[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== "user") continue;
    if (m.content.some((b) => b.type === "text" && (b.text ?? "").trim())) return null;
    for (const b of m.content) {
      if (b.type !== "tool_result" || typeof b.content !== "string") continue;
      try {
        const d = (JSON.parse(b.content) as { delivery_answer?: { kind?: unknown; say?: unknown } }).delivery_answer;
        if (d?.kind === "DIRECT" && typeof d.say === "string" && d.say.trim()) return d.say;
      } catch {
        // Kết quả không phải JSON ⇒ không phải căn cứ.
      }
    }
  }
  return null;
}

/** Đơn đã khép (giao xong / hoàn) — không đếm là «đơn đang mở» khi hỏi lịch giao. */
const CLOSED_ORDER_STAGES = new Set(["DELIVERED", "PAID", "RETURNED", "PARTIAL_RETURN"]);

export type DeliveryPick<T> = { kind: "TARGET"; target: T; liveOrders: number } | { kind: "NOT_APPLICABLE"; why: string };

/**
 * Đơn mà câu hỏi lịch giao nói tới — CHỈ đơn của LƯỢT MUA HIỆN TẠI: đơn bot vừa chốt (`confirmedId`), hoặc đơn không thuộc lượt mua
 * cũ (`pastIds`) và tạo trong `windowDays` ngày (cùng cửa sổ của vòng đời khách). HÀM THUẦN. `rows` xếp mới ⇒ cũ.
 *  · Có đơn NEW đang mở (đơn nháp / chưa chốt) ⇒ NOT_APPLICABLE: luồng bán hàng lo (khách dặn ngày giao ⇒ ghi chú giao hàng).
 *  · Không có đơn sống của lượt hiện tại ⇒ NOT_APPLICABLE — không bao giờ trả lời lịch giao bằng đơn cũ đã giao / huỷ / hoàn.
 *  · `liveOrders` chỉ đếm đơn còn mở (không đếm đơn đã khép).
 */
export function pickDeliveryOrder<T extends { id: string; stage: string; insertedAt: Date }>(rows: readonly T[], o: { confirmedId: string | null; pastIds: readonly string[]; now: Date; windowDays: number }): DeliveryPick<T> {
  const since = o.now.getTime() - o.windowDays * 86_400_000;
  const current = rows.filter((r) => r.id === o.confirmedId || (!o.pastIds.includes(r.id) && r.insertedAt.getTime() >= since));
  if (current.some((r) => r.stage === "NEW")) return { kind: "NOT_APPLICABLE", why: "đơn nháp / chưa chốt đang mở — luồng bán hàng" };
  const live = current.filter((r) => r.stage !== "CANCELLED" && r.stage !== "DELETED");
  if (!live.length) return { kind: "NOT_APPLICABLE", why: "không có đơn sống của lượt mua hiện tại" };
  const open = live.filter((r) => !CLOSED_ORDER_STAGES.has(r.stage));
  return { kind: "TARGET", target: open[0] ?? live[0], liveOrders: open.length };
}

// ─────────────────────────── MONG MUỐN GIỜ GIAO TRƯỚC KHI CHỐT (#871, ca «Ngọc Nguyễn» HSLC 16/10/2026) ───────────────────────────

/** Lời RÀO cả câu (không phải hứa): «mong muốn», «kiểm tra», «báo lại», «xác nhận lại», «cố gắng», «nếu được». Đã chuẩn hoá. */
const HEDGE_RE = /(?:^|\s)(?:xacnhan lai|xacnhan|mong muon|kiem tra|bao lai|co gang|neu duoc|neu kip|du kien|se bao)(?=\s|$)/;
/** «Ghi nhận / ghi chú» chỉ rào ĐÚNG VẾ chứa nó: «Dạ em ghi nhận, mai 9h shipper giao tới chị nhé» vẫn là lời HỨA ở vế sau (review PR #878). */
const NOTE_HEDGE_RE = /(?:^|\s)(?:ghi nhan|ghi chu|ghi lai|luu y)(?=\s|$)/;
/** Mốc giờ / ngày khách nêu: «9h», «9 giờ», «9g30», «thứ 7», «chủ nhật», «ngày 18». Bản gập dấu. */
const CLOCK_RE = /(?:^|\s)(?:\d{1,2} ?(?:h|g|gio)(?:\s?\d{1,2})?|thu (?:\d|hai|ba|tu|nam|sau|bay)|chu nhat|ngay \d{1,2})(?=\s|$)/;
/** Ngày giao MUỘN HƠN trên chính đơn này («tuần sau giao», «giao tháng sau», «cuối tuần giao») — mong muốn giờ giao, KHÔNG phải «mua lần sau». */
const LATER_DATE_RE = /(?:^|\s)(?:tuan (?:sau|toi|nay)|thang (?:sau|toi)|cuoi tuan|dau tuan)(?=\s|$)/;

/**
 * Tin khách là MONG MUỐN thời gian giao gắn với một mốc («Giao sáng mai khoảng 9h», «chiều nay giao giúp chị», «thứ 7 giao nhé») —
 * không phải câu hỏi «bao giờ giao» trần. Trả nguyên văn đã gọn (để ghi vào ghi chú đơn) hoặc `null`. HÀM THUẦN.
 */
export function deliveryPreferenceOf(input: string): string | null {
  // SĐT không bao giờ vào ghi chú giờ giao (review PR #878: «mai giao em nhé, sdt 09…» từng lưu nguyên SĐT vào state + ghi chú đơn).
  const text = withoutPhones(input).trim();
  if (!text) return null;
  const q = classifyDeliveryQuestion(text);
  const f = normalizeAsk(text);
  // «thứ 7 giao giúp chị» không có chữ hỏi «khi nào / hôm nay / mai» nên bộ phân loại không gọi là DELIVERY_TIME — mốc + động từ giao là đủ.
  const clockWithVerb = (CLOCK_RE.test(f) || LATER_DATE_RE.test(f)) && /(?:^|\s)(?:giao|ship|gui|nhan|phat)(?=\s|$)/.test(f);
  const anchored = q?.intent === "DELIVERY_TIME" ? q.nuance === "TODAY" || q.nuance === "TOMORROW" || CLOCK_RE.test(f) : clockWithVerb;
  if (!anchored) return null;
  // CÂU HỎI chính sách («giao trong ngày được không», «mai có giao không?») không phải lời hẹn — câu trả lời theo chính sách shop đi bình thường.
  if (text.includes("?") || /(?:^|\s)(?:khong|ko|k|hong|hok|chua|kip khong|kip ko)(?:\s(?:a|em|shop|nhi|vay|ha|ban))?\s*$/.test(f)) return null;
  // Tin GỘP món + SĐT + địa chỉ + giờ giao (P0 21/10/2026): vế là ĐỊA CHỈ (đọc bằng chính bộ đọc địa chỉ — có đường / khu, hoặc ra tỉnh)
  // không vào ghi chú hẹn giờ; còn lại giữ nguyên chữ khách. Một vế duy nhất ⇒ giữ nguyên như cũ.
  // Tách vế trên tin GỐC (bỏ SĐT sau): `withoutPhones` gộp xuống dòng, tin nhiều dòng sẽ thành một vế.
  const parts = input.split(/[\n,;]+/).map((p) => withoutPhones(p).trim()).filter(Boolean);
  const places = new Set(adminPlaceNamesFolded());
  const isPlace = (p: string) => looksLikeDeliveryAddress(p) || looksLikeStreetFragment(p) || parseCustomerAddress(p).province !== null || places.has(foldVnText(p.replace(/^(?:quận|q\.?|phường|p\.?|huyện|xã|thị xã)\s+/iu, "")));
  // Vế trộn món với nơi giao («1kg chả mực về ngõ 218 Lĩnh Nam») ⇒ bỏ phần «về / tới / đến / ở / tại + địa chỉ», giữ phần trước.
  const headOf = (p: string) => {
    const m = p.match(/^(.*?)\s+(?:về|tới|đến|ở|tại)\s+(.+)$/iu);
    return m && m[1].trim() && isPlace(m[2]) ? m[1].trim() : p;
  };
  const kept = parts.length > 1 ? parts.filter((p) => !isPlace(p)).map(headOf) : parts;
  return (kept.length ? kept.join(", ") : text).replace(/\s+/g, " ").trim().slice(0, 160);
}

/** Dòng ghi chú đơn cho mong muốn giờ giao — kèm MỐC KHÁCH NHẮN (giờ VN) để «sáng mai» đọc được ngày nào. HÀM THUẦN. */
export function deliveryPreferenceNote(pref: { text: string; at: string }): string {
  const at = new Date(pref.at);
  const when = Number.isFinite(at.getTime()) ? new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", year: "numeric" }).format(at) : "";
  return `Khách hẹn giờ giao (CHƯA xác nhận với ĐVVC): «${pref.text}»${when ? ` — khách nhắn lúc ${when}` : ""}`;
}

/**
 * Câu của model HỨA một mốc giao («mai 9h em giao cho mình nhé», «sáng mai bên em giao tới») — bỏ qua câu GHI NHẬN («em ghi nhận mong muốn
 * giao sáng mai, shop kiểm tra rồi báo lại»). Trả các câu hứa (để nơi gọi bỏ đúng câu đó). HÀM THUẦN.
 */
export function deliveryPromiseIn(reply: string): string[] {
  // Tách câu KHÔNG dùng nhìn-ngược (Safari < 16.4 sập cả trang khi một tệp lib/* có `(?<=` tới trình duyệt).
  const parts = reply.replace(/([.!?…])\s+/g, "$1\n").split(/\n+/).map((x) => x.trim()).filter(Boolean);
  const promises = (f: string) => PROMISE_RE.test(f) || (CLOCK_RE.test(f) && /(?:^|\s)(?:giao|ship|gui|toi|den)(?=\s|$)/.test(f));
  return parts.filter((p) => {
    const f = normalizeAsk(p);
    if (!promises(f) || HEDGE_RE.test(f)) return false;
    // «ghi nhận» chỉ miễn cho vế chứa nó — vế khác của cùng câu mà hứa mốc vẫn là lời hứa.
    return (
      !NOTE_HEDGE_RE.test(f) ||
      p.split(/[,;:–—]+/).some((c) => {
        const fc = normalizeAsk(c);
        return promises(fc) && !NOTE_HEDGE_RE.test(fc);
      })
    );
  });
}
