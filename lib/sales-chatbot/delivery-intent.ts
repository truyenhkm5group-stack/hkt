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
import { NO_SHIPMENT_YET } from "@/lib/sales-chatbot/order-status-shared";
import { foldVi } from "@/lib/sales-chatbot/text";

export type DeliveryNuance = "TODAY" | "TOMORROW" | "URGENT" | "GENERIC";
export type DeliveryQuestion = { intent: "DELIVERY_TIME"; nuance: DeliveryNuance } | { intent: "ORDER_STATUS"; nuance: null };

/** Câu nói với khách khi máy chủ KHÔNG có lịch giao đã xác minh. */
export const DELIVERY_HANDOFF_TEXT = "Dạ em báo nhân viên xác nhận giờ giao cho mình ngay ạ.";
/** Câu trạng thái chung của `customerOrderStatus` khi đơn không vận đơn — KHÔNG được dùng làm câu trả lời cho câu hỏi lịch giao. */
export const GENERIC_STATUS_PHRASE = NO_SHIPMENT_YET.slice(NO_SHIPMENT_YET.indexOf("chưa có"));
/** Tiền tố tin phía shop trong lịch sử (= `SHOP_SAID` của engine.ts; bài kiểm so hai giá trị). */
export const DELIVERY_SHOP_SAID_PREFIX = "[Shop đã nhắn]";

/**
 * Chuẩn hoá trước khi gấp dấu: các từ MẤT NGHĨA khi bỏ dấu được thay bằng một mã riêng để không lẫn với động từ giao hàng —
 * «nhắn» ≠ «nhận», «gặp» ≠ «gấp», «nhân viên» không phải «nhận». Bản không dấu vẫn mơ hồ ⇒ chỉ tách được khi khách gõ có dấu.
 */
function normalizeAsk(text: string): string {
  const raw = text
    .normalize("NFC")
    .toLowerCase()
    .replace(/nhắn/g, " nhantin ")
    .replace(/gặp/g, " gapmat ")
    .replace(/nhân viên/g, " nhanvien ")
    .replace(/tôi/g, " toiminh ");
  return ` ${foldVi(raw)
    .replace(/\bnhan vien\b/g, "nhanvien")
    .replace(/\bgui (?:tien|anh|hinh|so|dia chi|sdt|stk|lai so)\b/g, "guithongtin")
    .replace(/\bhnay\b/g, "hom nay")
    .replace(/\bbh\b/g, "bao gio")} `;
}

const VERB = String.raw`(?:giao|ship|gui|nhan|co hang|toi|den|ve|phat|shipper|buu ta)`;
const has = (f: string, re: string) => new RegExp(String.raw`(?:^|\s)${re}(?=\s|$)`).test(f);

const WHEN = String.raw`(?:hom nao|bao gio|khi nao|luc nao|ngay nao|may gio|may ngay|may hom|bao lau|thu may|bao nhieu ngay|bao nhieu lau)`;
const TODAY = String.raw`(?:hom nay|trong ngay|chieu nay|sang nay|trua nay|toi nay|ngay hom nay)`;
const TOMORROW = String.raw`(?:mai|ngay mai|sang mai|chieu mai|toi mai|trua mai|mot|ngay mot)`;
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
  const verb = new RegExp(String.raw`\s${VERB}\s`).test(f);
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

/** Tin mới nhất phía SHOP (tiền tố `[Shop đã nhắn]`, tức NHÂN VIÊN — không phải chữ bot) có nói lịch giao. HÀM THUẦN. */
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
  /** Câu NHÂN VIÊN đã nói về lịch giao trong hội thoại (`staffDeliveryCommitment`). */
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
  if (f.staffSaid) return handoff(`nhân viên đã hẹn «${f.staffSaid}» — AI không nói khác`);
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
    const key = vnDayKey(f.promisedAt);
    if (key >= vnDayKey(f.now) && !urgent) return { kind: "DIRECT", text: `Dạ đơn mình đang hẹn giao ngày ${ddmm(key)} ạ.`, basis: "ngày hẹn giao ghi trên đơn" };
    if (urgent) return handoff("khách xin giao gấp — đơn đang có ngày hẹn giao");
    return handoff("ngày hẹn giao trên đơn đã qua mà chưa có vận đơn");
  }
  return handoff(s ? "đã có vận đơn nhưng chưa có chứng từ ĐVVC về lịch giao" : "đơn chưa có vận đơn, chưa có lịch giao xác minh");
}

const PROMISE_RE = /(?:^|\s)(?:hom nay|trong ngay|chieu nay|sang nay|toi nay|trua nay|ngay mai|mai|sang mai|chieu mai)(?:\s\S+){0,3}\s(?:giao|toi|den|co hang|nhan|ship|phat)(?=\s|$)|(?:^|\s)(?:giao|ship|gui|toi|den|nhan duoc)(?:\s\S+){0,3}\s(?:hom nay|trong ngay|chieu nay|sang nay|toi nay|ngay mai|mai|sang mai|chieu mai)(?=\s|$)/;

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
  const fr = ` ${foldVi(r)} `;
  if (PROMISE_RE.test(fr) && !(verified && PROMISE_RE.test(` ${foldVi(verified)} `))) return "Khách hỏi lịch giao — bản nháp hứa mốc giao (hôm nay / ngày mai) mà máy chủ không có căn cứ";
  return null;
}
