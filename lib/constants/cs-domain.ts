import { CASE_SLA_HOURS } from "@/lib/constants/action-queue";
import { CS_BOT_ASSIGNEES, type CsKind, type CsStatus } from "@/lib/constants/cs";

/**
 * ═══════════ MỘT VẤN ĐỀ MỘT CHỦ SỞ HỮU: CSKH ≠ GIAO VẬN ═══════════
 *
 * Đo trên production 11/09/2026: 232 case CSKH đang mở, **183 trong đó là "giao không thành"** do
 * bot sinh ra từ `shipments.stage = 'DELIVERY_FAILED'`. Cùng một kiện hàng lúc đó tạo ra BA thứ:
 *
 *   1. một dòng trong hàng đợi care của trang Vận đơn (rổ `DELIVERY_FAILED` của tháp giao vận),
 *   2. một thông báo `SHIPMENT_FAILED` (đội LOGISTICS),
 *   3. một case `cs_cases` → thông báo `CS_CASE` / `CS_CASE_GROUP` (đội CS).
 *
 * Ba dòng, một sự việc. Người CSKH mở tab CSKH thấy 183 việc mà **không việc nào làm được ở đó**:
 * muốn phát lại phải sang trang vận đơn, muốn duyệt hoàn cũng vậy. Và mọi con số "tồn đọng CSKH"
 * đều sai theo đúng 183 đơn vị.
 *
 * ─── LUẬT PHÂN MIỀN (không suy từ chữ trong tiêu đề) ───
 *
 *  · `LOGISTICS` — việc BẮT NGUỒN TỪ TRẠNG THÁI VẬN CHUYỂN. Nhận diện bằng NGUỒN SINH RA CASE
 *    (`shipments` / sự kiện Viettel Post), không bằng từ khoá trong tiêu đề.
 *  · `CUSTOMER`  — việc bán hàng / chăm khách: chốt đơn, đổi mẫu, tư vấn, khiếu nại, giục giao.
 *  · `BY_SHIPMENT` — CÙNG MỘT LOẠI CASE nhưng miền phụ thuộc VÒNG ĐỜI của đơn, không phụ thuộc
 *    chữ nghĩa: sai SĐT / sai địa chỉ khi CHƯA có vận đơn là việc của CSKH (sửa trước khi gửi);
 *    khi ĐÃ có vận đơn đang chạy thì chính lỗi đó đang cản bưu tá giao — nó là việc của care vận
 *    đơn, nơi có nút sửa người nhận và gửi yêu cầu sang ĐVVC.
 *
 * ─── KHÔNG XOÁ GÌ CẢ ───
 *
 * Phân miền chỉ đổi CHỖ HIỂN THỊ và CHỖ ĐẾM. Case gốc, lịch sử, `dedupe_key`, audit giữ nguyên;
 * trang CSKH vẫn xem được case giao vận qua bộ lọc "Miền", chỉ là không nằm trong hàng đợi mặc
 * định nữa.
 *
 * ─── KHÔNG SUY MIỀN TỪ TIỀN ───
 *
 * Miền được quyết bởi thực thể sinh ra việc (đơn / vận đơn), KHÔNG bởi COD, `cod_status` hay bảng
 * kê. Trạng thái ĐVVC vẫn là chứng từ; trạng thái care vẫn là trạng thái công việc — hai chiều
 * riêng, đúng như `lib/constants/care.ts` đã chốt.
 */
export type CsDomain = "CUSTOMER" | "LOGISTICS";

/** Quy tắc phân miền của từng loại case. `BY_SHIPMENT` = quyết theo vòng đời, xem `csDomainOf`. */
export type CsDomainRule = CsDomain | "BY_SHIPMENT";

export const CS_KIND_DOMAIN: Record<CsKind, CsDomainRule> = {
  // Sinh thẳng từ `shipments.stage = 'DELIVERY_FAILED'` (lib/cs/failed-delivery.ts) — chứng từ ĐVVC.
  DELIVERY_FAILED: "LOGISTICS",
  // Lỗi thông tin: trước khi gửi là việc CSKH, đang giao là việc care vận đơn.
  WRONG_ADDRESS: "BY_SHIPMENT",
  WRONG_PHONE: "BY_SHIPMENT",
  // Còn lại là việc bán hàng / chăm khách, kể cả khi nội dung có nhắc tới chuyện giao hàng:
  // nguồn của chúng là hội thoại / thẻ đơn / phiếu đổi trả, không phải sự kiện Viettel Post.
  ORDER_NOT_CREATED: "CUSTOMER",
  EXCHANGE_SIZE: "CUSTOMER",
  EXCHANGE_COLOR: "CUSTOMER",
  RETURN: "CUSTOMER",
  COMPLAINT: "CUSTOMER",
  SIZE_ADVICE: "CUSTOMER",
  WRONG_PRICE: "CUSTOMER",
  URGE_DELIVERY: "CUSTOMER",
  PHONE_VERIFY: "CUSTOMER",
  OTHER: "CUSTOMER",
};

export const CS_DOMAIN_LABEL: Record<CsDomain, string> = {
  CUSTOMER: "CSKH · bán hàng",
  LOGISTICS: "Vận đơn & care",
};

export const CS_DOMAINS: readonly CsDomain[] = ["CUSTOMER", "LOGISTICS"];

/** Loại case luôn thuộc giao vận, bất kể đơn có vận đơn hay không. */
export const CS_LOGISTICS_KINDS: readonly CsKind[] = (Object.keys(CS_KIND_DOMAIN) as CsKind[]).filter((k) => CS_KIND_DOMAIN[k] === "LOGISTICS");
/** Loại case mà miền phụ thuộc vòng đời gửi hàng. */
export const CS_LIFECYCLE_KINDS: readonly CsKind[] = (Object.keys(CS_KIND_DOMAIN) as CsKind[]).filter((k) => CS_KIND_DOMAIN[k] === "BY_SHIPMENT");

/**
 * Miền của MỘT case. `hasActiveShipment` = đơn của case đang có vận đơn CHƯA kết thúc
 * (`shipments.is_final = false`) — đúng phép nối mà hàng đợi care dùng ở
 * `lib/queries/care-workbench.ts::loadWrongInfoCases`, để hai bên không thể kết luận lệch nhau.
 *
 * CHƯA BIẾT không tồn tại ở đây: không có vận đơn nào đang chạy nghĩa là chưa cản trở việc giao,
 * và việc đó thuộc về người đang nói chuyện với khách.
 */
export function csDomainOf(kind: string, hasActiveShipment: boolean): CsDomain {
  const rule = CS_KIND_DOMAIN[kind as CsKind] ?? "CUSTOMER";
  if (rule === "BY_SHIPMENT") return hasActiveShipment ? "LOGISTICS" : "CUSTOMER";
  return rule;
}

/**
 * TRẠNG THÁI CÒN PHẢI LÀM. `DONE` / `AUTO_RESOLVED` / `CANCELLED` đã xong hoặc đã bỏ — chúng là
 * lịch sử, không phải hàng đợi. Hàng đợi mặc định của CSKH chỉ hiện các trạng thái này.
 */
export const CS_ACTIONABLE_STATUSES: readonly CsStatus[] = ["OPEN", "IN_PROGRESS"];

/**
 * "Bot ERP" là NGƯỜI TẠO, không phải người xử lý.
 *
 * `lib/cs/failed-delivery.ts` và `lib/cs/phone-verify.ts` ghi `assignee = 'Bot ERP'` sau khi nhắn
 * khách thành công. Đọc nguyên văn thì hàng đợi trông như đã có người lo — trong khi thực tế chưa
 * ai nhận. Ở mọi chỗ đếm "đã có người phụ trách", bot phải bị coi là CHƯA AI NHẬN.
 */
export function isBotAssignee(assignee: string | null | undefined): boolean {
  return Boolean(assignee && CS_BOT_ASSIGNEES.includes(assignee));
}

/** Người thật đang cầm case (rỗng nếu chưa ai nhận hoặc mới chỉ có bot chạm vào). */
export function humanAssignee(assignee: string | null | undefined): string {
  return !assignee || isBotAssignee(assignee) ? "" : assignee;
}

/**
 * Hạn xử lý một case CSKH (giờ) — MỘT con số, lấy từ bảng hạn chung của hàng đợi việc.
 *
 * Nằm ở `lib/constants/*` chứ không ở `lib/queries/*` vì bảng CSKH (client component) cũng phải
 * biết dòng nào quá hạn để tô đỏ, mà client KHÔNG được import `lib/queries/*` (AGENTS.md mục 2).
 * `lib/queries/cs.ts` xuất lại đúng hằng này để nơi gọi cũ không phải sửa.
 */
export const CS_CASE_SLA_HOURS = CASE_SLA_HOURS.CS_CASE ?? 4;
