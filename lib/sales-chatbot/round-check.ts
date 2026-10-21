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
