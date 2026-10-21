import { manualOrderShortCode } from "@/lib/constants/manual-orders";
import { classifyCartMessage, foldCart } from "@/lib/sales-chatbot/cart-commitment";
import type { CustomerPhase } from "@/lib/sales-chatbot/lifecycle";

/**
 * ĐƠN CŨ HAY ĐƠN MỚI (P0 21/10/2026, HSLC «Ngọc Bích», đã che tên / SĐT / địa chỉ).
 *
 * 18/10 bot chốt đơn 1kg chả cá thu (cờ địa chỉ còn mở, chưa rời kho). 21/10 khách bấm quảng cáo lại, bot báo giá «1kg hay 2kg?», khách
 * «1kg thôi». Đơn 18/10 còn trong `POST_ORDER_HANDOFF_MS` (3 ngày) nên vẫn là «đơn của lượt này»: model gọi `update_draft_order`
 * («Sửa đơn đã chốt» — không đổi gì) + `confirm_order` («Đơn đã chốt từ trước») rồi im, mức sẵn sàng là `CONFIRMED` ⇒ câu chung «nói rõ
 * hơn». Khách nhắc lại, gửi SĐT, gửi địa chỉ mới (KCN) ⇒ địa chỉ bị coi là ĐỔI ĐIỂM GIAO của đơn 18/10 ⇒ «địa chỉ chưa chắc» ⇒ chuyển
 * người; nhân viên lên đơn thứ hai cùng món cùng số lượng.
 *
 * Bộ đọc giỏ KHÔNG sai (đã đo: «1kg thôi», «nửa ký», «1,5kg», «thôi lấy 1kg» đều ghi đúng số). Sai là BỐI CẢNH: một lời mua mới ngày hôm
 * sau trên nền một đơn đã chốt chưa đi. Máy chủ quyết, không để model đoán:
 *   · đơn đã chốt ở NGÀY TRƯỚC (giờ VN), còn chưa rời kho (`AWAITING_SHIPMENT`), khách nói một số lượng khẳng định (không phải câu sửa,
 *     không phải trả lời lời mời mua thêm) ⇒ MỘT câu: ghi nhận đúng món + số lượng khách vừa nói, nêu đơn đang có (mã · tổng · ngày) và hỏi
 *     ĐẶT THÊM hay VẪN ĐƠN ĐÓ. Không khẳng định «shop chưa gửi»: tổ chức tạo vận đơn ngoài ERP thì ERP không biết (bài học #BD31267C);
 *   · đơn cũ đã rời kho / đã giao ⇒ không thể là cùng một đơn đang sửa ⇒ lượt mua MỚI ngay, không hỏi;
 *   · câu trả lời: «đặt thêm / đơn mới» ⇒ lượt mua MỚI (giỏ của lời mua vừa rồi đi theo) · «đơn cũ / vẫn đơn đó» ⇒ giữ đơn cũ (đổi địa
 *     chỉ / món đi đường sửa đơn có hàng rào như cũ) · không rõ ⇒ chuyển người kèm lý do, KHÔNG lên đơn thứ hai.
 * Cùng ngày với lúc chốt ⇒ không hỏi: «2kg nhé» vài giờ sau khi chốt là sửa đơn vừa đặt (luồng cũ). HÀM THUẦN.
 */
export type RoundCheckState = { orderId: string; askedTurn: number; at: string; answer?: "NEW" | "SAME" };
export type RoundStep = { kind: "ASK"; text: string; check: RoundCheckState } | { kind: "NEW_ROUND" } | null;

const vnDay = (d: Date) => new Date(d.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
const vnDayMonth = (d: Date) => {
  const s = vnDay(d);
  return `${s.slice(8, 10)}/${s.slice(5, 7)}`;
};

/** Động từ SỬA đơn tường minh — «đổi thành 2kg», «sửa còn 1kg», «bớt 1kg» là sửa đơn đang có, không phải lời mua mới. */
const EDIT_VERB_RE = /(?:^| )(?:doi|sua|giam|tru|bot|xuong|huy|bo|them)(?= |$)/;

/** Một câu nói số lượng KHẲNG ĐỊNH («1kg thôi», «2kg nhé», «nửa ký», «lấy một ký», «thôi lấy 1kg»). HÀM THUẦN. */
export function purchaseAmountIntent(text: string, catalog?: readonly string[]): boolean {
  const c = classifyCartMessage(text, catalog);
  if ((c.kind !== "ORDER" && c.kind !== "SET") || !c.amounts.length || c.tentative) return false;
  return !EDIT_VERB_RE.test(foldCart(text));
}

/*
  TRẢ LỜI SỐ LƯỢNG NGẮN (P0 21/10/2026, HSLC «Lan Nguyen»): bot hỏi «1kg hay 2kg?», khách «2kg» ⇒ câu mẫu báo giá khớp chữ «kg» đi LẠI
  nguyên văn và hỏi «mình muốn mua 2kg ạ?». Tin chỉ mang MỘT số lượng (cộng tiểu từ / động từ mua / tên món đã gắn) là câu TRẢ LỜI, không
  phải câu hỏi mới: máy chủ ghi nhận và đi tiếp bước bán — không câu mẫu, không lượt AI.
*/
const QTY_FILLER = new Set(["thoi", "thui", "nhe", "nha", "nhen", "nghen", "a", "ah", "em", "e", "chi", "c", "anh", "lay", "cho", "mua", "dat", "minh", "ok", "oke", "okie", "vay", "di", "shop", "nhi", "luon", "con", "the", "duoc", "dc", "roi", "r", "thi", "la", "vang", "da", "u", "uh", "um", "ừ"]);

/**
 * Tin bot / page ngay trước là CÂU HỎI chọn số lượng / quy cách («… 1kg hay 2kg ạ?», «Chị lấy loại nào ạ?», «mình lấy mấy hộp?»). Chỉ khi
 * đó một tin chỉ có số lượng mới là CÂU TRẢ LỜI — tin đầu tiên khách tự nói («1kg chả cá thu nhé em») là lượt chọn món, nơi luật #868
 * đặt câu mời mua thêm. HÀM THUẦN.
 */
export function askedQuantityChoice(botText: string | null): boolean {
  if (!botText || !botText.includes("?")) return false;
  return /(?:^| )(?:hay|loai nao|bao nhieu|may (?:kg|ky|hop|goi|tui|hu|cai)|may)(?= |$)/.test(foldCart(botText));
}

/** Tin chỉ là MỘT câu trả lời số lượng («2kg», «2kg nhé», «lấy 2», «nửa ký», «2kg thôi») cho món `labels`. HÀM THUẦN. */
export function quantityOnlyAnswer(text: string, labels: readonly string[]): boolean {
  if (!text.trim() || text.includes("?")) return false;
  const c = classifyCartMessage(text);
  if ((c.kind !== "ORDER" && c.kind !== "SET") || c.amounts.length !== 1 || c.tentative) return false;
  const a = c.amounts[0];
  const rest = foldCart(`${text.slice(0, a.index)} ${text.slice(a.end)}`).split(" ").filter(Boolean);
  const labelWords = new Set(labels.flatMap((l) => foldCart(l).split(" ")));
  return rest.every((w) => QTY_FILLER.has(w) || labelWords.has(w));
}

/**
 * «lấy 2» ngay sau câu hỏi «1kg hay 2kg?» là 2kg: số TRẦN (không đơn vị) khớp ĐÚNG MỘT lựa chọn «N<đơn vị>» trong câu hỏi lựa chọn ngay trước
 * («… hay …») ⇒ trả «2kg» để bộ đọc giỏ đọc như khách gõ đủ. Không khớp lựa chọn nào / câu trước không phải câu hỏi lựa chọn ⇒ `null`
 * (không đoán đơn vị). HÀM THUẦN.
 */
export function choiceAmountText(text: string, botText: string | null): string | null {
  if (!botText || !/\bhay\b/iu.test(botText) || !botText.includes("?")) return null;
  const m = foldCart(text).match(/^(?:(?:lay|cho|mua|dat|ok|oke|u|vang|da|chi|c|em|e|minh|anh|toi)\s+)*(\d+(?:[.,]5)?)(?:\s+(?:thoi|thui|nhe|nha|a|em|e|chi|c|nhen|luon|di|nhe))*$/);
  if (!m) return null;
  const n = m[1].replace(",", ".");
  const units = [...botText.toLowerCase().matchAll(/(\d+(?:[.,]\d+)?)\s?(kg|ký|kí|g|gr|hộp|gói|túi|hũ|cái|chai|bộ)(?![\p{L}])/gu)].filter((x) => x[1].replace(",", ".") === n).map((x) => x[2]);
  const distinct = [...new Set(units)];
  return distinct.length === 1 ? `${m[1]}${distinct[0]}` : null;
}

/**
 * TIN HAI Ý (P0 21/10/2026, ca «Xuân Đoàn»: «Cho chị 2kg. Mấy ngày nhận được hàng.»): tách theo câu; đúng MỘT câu là câu trả lời số lượng
 * (`quantityOnlyAnswer`), mọi câu còn lại là câu hỏi thời gian giao (`isDeliveryAsk` — bộ phân loại lịch giao truyền vào, không chép luật).
 * Trả `null` khi không đúng dáng đó (câu thứ hai là chuyện khác ⇒ để model đọc cả tin). HÀM THUẦN.
 */
export function quantityWithDeliveryAsk(text: string, labels: readonly string[], isDeliveryAsk: (s: string) => boolean): { quantity: string; delivery: string } | null {
  // Tách tại dấu câu / dấu phẩy (không nhìn-ngược — Safari < 16.4); vế nào không phải số lượng thì phải là câu hỏi giao, không thì `null`.
  const parts = text.split(/[.!?\n;,]+/u).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const qty = parts.filter((p) => quantityOnlyAnswer(p, labels));
  if (qty.length !== 1) return null;
  const rest = parts.filter((p) => p !== qty[0]);
  return rest.length && rest.every(isDeliveryAsk) ? { quantity: qty[0], delivery: rest.join(" ") } : null;
}

/** Câu đáp phần hỏi thời gian giao khi CHƯA có địa chỉ: không mốc, không số ngày (máy chủ không có căn cứ trước khi biết nơi giao). */
export const DELIVERY_ASK_NEEDS_ADDRESS = "Thời gian nhận hàng tuỳ địa chỉ giao — mình gửi em địa chỉ, em báo thời gian dự kiến cho mình ạ.";

const LIVE_UNSHIPPED: readonly CustomerPhase[] = ["AWAITING_SHIPMENT"];
const SHIPPED_OR_DONE: readonly CustomerPhase[] = ["IN_TRANSIT", "RECEIVED", "AFTER_SALES"];

export function roundCheckStep(i: {
  confirmed: { orderId: string | null; simulated: boolean; total: number; at: string } | undefined;
  phase: CustomerPhase | null;
  text: string;
  catalog?: readonly string[];
  turn: number;
  now: Date;
  prior?: RoundCheckState;
  /** Tin này trả lời NGAY một lời mời mua thêm của lượt hiện tại — đó là việc của bộ lời mời, không phải lời mua mới. */
  answersOffer: boolean;
  /** «1kg Chả cá thu» — món + số lượng khách vừa nói (giỏ có thẩm quyền), `null` khi chưa gắn được món. */
  saidLine: string | null;
  money: (n: number) => string;
}): RoundStep {
  const c = i.confirmed;
  if (!c?.orderId || c.simulated || !i.phase) return null;
  const at = new Date(c.at);
  if (!Number.isFinite(at.getTime()) || vnDay(at) === vnDay(i.now)) return null;
  if (i.answersOffer || !purchaseAmountIntent(i.text, i.catalog)) return null;
  if (SHIPPED_OR_DONE.includes(i.phase)) return { kind: "NEW_ROUND" };
  if (!LIVE_UNSHIPPED.includes(i.phase) || i.prior?.orderId === c.orderId) return null;
  const code = manualOrderShortCode(c.orderId);
  const ack = i.saidLine ? `Dạ em ghi nhận mình lấy ${i.saidLine} ạ. ` : "Dạ ";
  return {
    kind: "ASK",
    text: `${ack}Mình đang có đơn #${code} (${i.money(c.total)}) đặt ngày ${vnDayMonth(at)} — lần này mình muốn đặt thêm một đơn mới, hay vẫn là đơn đó ạ?`,
    check: { orderId: c.orderId, askedTurn: i.turn, at: i.now.toISOString() },
  };
}

const NEW_RE = /(?:^| )(?:(?:dat|mua|lay|len|tao) (?:them|moi)|(?:don|1 don|mot don) (?:moi|khac|nua)|them (?:1 |mot )?don|ca hai|ca 2|2 don|hai don|don moi)(?= |$)|^(?:moi|don moi)(?: (?:a|nhe|nha|em|e|chi|c))*$/;
const SAME_RE = /(?:^| )(?:don cu|don truoc|don hom truoc|don hom (?:do|kia|bua)|(?:la |van la |van |chinh |cung )don (?:do|kia|truoc|cu|ay|nay)|giu don|(?:khong|ko|k) phai don moi|(?:khong|ko|k) (?:dat|mua) them)(?= |$)|^(?:cu|don cu|van don do|don do)(?: (?:a|nhe|nha|em|e|chi|c))*$/;

/** Câu trả lời cho câu hỏi đơn cũ / đơn mới. Cả hai hoặc không cái nào ⇒ `null` (người quyết). HÀM THUẦN. */
export function roundCheckAnswer(text: string): "NEW" | "SAME" | null {
  const f = foldCart(text);
  // «không phải đơn mới», «không đặt thêm» là lời giữ đơn cũ — gỡ cụm phủ định trước khi xét phía «đặt thêm».
  const n = NEW_RE.test(f.replace(/(?:^| )(?:khong|ko|k) (?:phai don moi|(?:dat|mua) them)(?= |$)/g, " "));
  const s = SAME_RE.test(f);
  return n === s ? null : n ? "NEW" : "SAME";
}

/** Lý do chuyển người khi khách không trả lời rõ — người hỏi khách trước khi lên đơn thứ hai. HÀM THUẦN. */
export function roundCheckHandoffReason(orderId: string, at: string): string {
  return `Cần người xử lý — khách có đơn #${manualOrderShortCode(orderId)} (đặt ${vnDayMonth(new Date(at))}) chưa rời kho và vừa nhắn mua lại — chưa rõ đặt thêm hay vẫn đơn đó; hỏi khách trước khi lên đơn thứ hai`;
}
