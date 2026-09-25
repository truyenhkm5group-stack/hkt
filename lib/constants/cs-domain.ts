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
 * ─── LUẬT PHÂN MIỀN — CHỦ SHOP CHỐT 25/09/2026 ───
 *
 *   **"Chưa giao cho ĐVVC thì thuộc CSKH, giao cho ĐVVC rồi thì thuộc Vận đơn."**
 *
 * Một ranh giới DUY NHẤT, không phụ thuộc loại case: Viettel Post đã THẬT SỰ cầm hàng chưa. "Đã
 * cầm" = đơn của case có một vận đơn ở chặng thuộc `CARRIER_HANDOFF_STAGES` (đã lấy hàng trở đi,
 * kể cả đang hoàn / đã hoàn) hoặc có mốc lấy hàng — đúng định nghĩa bàn giao của AGENTS.md mục 41.
 * "Chờ lấy hàng", "lấy thất bại", "shop huỷ lấy" là CHƯA giao ⇒ vẫn là CSKH.
 *
 *  · Chưa giao (chưa có đơn, chưa có vận đơn, hoặc vận đơn còn chờ lấy) ⇒ `CUSTOMER`, dù case là
 *    sai địa chỉ, giục giao, đổi size hay khiếu nại.
 *  · Đã giao cho ĐVVC ⇒ `LOGISTICS`, dù kiện đang chạy hay đã chốt (phát xong / đã hoàn), và dù
 *    case là khiếu nại, đổi size, trả hàng sau khi nhận.
 *  · Riêng `DELIVERY_FAILED` luôn là `LOGISTICS`: nó sinh ra TỪ một vận đơn đã ở tay ĐVVC.
 *
 * Bản trước chia theo loại case (việc về kiện đi theo kiện, việc về sản phẩm ở lại CSKH). Chủ shop
 * chọn ranh giới theo thời điểm bàn giao vì nó không cần ai phân vân "case này là về kiện hay về
 * sản phẩm" — nhìn vận đơn là biết của ai.
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
  // Sinh thẳng từ `shipments.stage = 'DELIVERY_FAILED'` (lib/cs/failed-delivery.ts) — kiện đã ở tay ĐVVC.
  DELIVERY_FAILED: "LOGISTICS",
  // Mọi loại còn lại: theo thời điểm bàn giao cho ĐVVC (xem đầu tệp).
  WRONG_ADDRESS: "BY_SHIPMENT",
  WRONG_PHONE: "BY_SHIPMENT",
  URGE_DELIVERY: "BY_SHIPMENT",
  RETURN: "BY_SHIPMENT",
  ORDER_NOT_CREATED: "BY_SHIPMENT",
  EXCHANGE_SIZE: "BY_SHIPMENT",
  EXCHANGE_COLOR: "BY_SHIPMENT",
  COMPLAINT: "BY_SHIPMENT",
  SIZE_ADVICE: "BY_SHIPMENT",
  WRONG_PRICE: "BY_SHIPMENT",
  PHONE_VERIFY: "BY_SHIPMENT",
  OTHER: "BY_SHIPMENT",
};

export const CS_DOMAIN_LABEL: Record<CsDomain, string> = {
  CUSTOMER: "CSKH · bán hàng",
  LOGISTICS: "Vận đơn & care",
};

export const CS_DOMAINS: readonly CsDomain[] = ["CUSTOMER", "LOGISTICS"];

/** Loại case luôn thuộc giao vận, bất kể đơn có vận đơn hay không. */
export const CS_LOGISTICS_KINDS: readonly CsKind[] = (Object.keys(CS_KIND_DOMAIN) as CsKind[]).filter((k) => CS_KIND_DOMAIN[k] === "LOGISTICS");
/**
 * Loại case NGƯỜI được tạo tay / luật từ khoá được trỏ tới.
 *
 * Loại miền `LOGISTICS` sinh ra TỪ CHỨNG TỪ ĐVVC (`lib/cs/failed-delivery.ts` đọc `shipments.stage`),
 * không từ một câu chat hay một thẻ đơn. Cho người gõ tay một case "giao không thành" — hay cho
 * luật từ khoá tự tạo nó — là dựng một case giao vận không gắn với kiện nào, nằm ngoài hàng đợi
 * care và không ai xử lý được ở đâu cả. `lib/actions/cs.ts` chặn ở lược đồ đầu vào.
 */
export const CS_HUMAN_KINDS: readonly CsKind[] = (Object.keys(CS_KIND_DOMAIN) as CsKind[]).filter((k) => CS_KIND_DOMAIN[k] !== "LOGISTICS");
/** Loại case mà miền phụ thuộc thời điểm bàn giao cho ĐVVC. */
export const CS_LIFECYCLE_KINDS: readonly CsKind[] = (Object.keys(CS_KIND_DOMAIN) as CsKind[]).filter((k) => CS_KIND_DOMAIN[k] === "BY_SHIPMENT");

/**
 * Miền của MỘT case. `handedOff` = đơn của case có ít nhất một vận đơn ĐVVC đã cầm hàng VÀ CHƯA
 * CHỐT (`csRunningHandoffExists` / `isRunningHandoff` trong `lib/queries/cs.ts`) — đúng mệnh đề mà
 * trang CSKH dùng để loại ra và bàn care dùng để nhận về, để hai bên không thể kết luận lệch nhau.
 * Kiện đã chốt (giao xong / đã hoàn / huỷ) ⇒ case về CSKH (chủ shop chốt lại 25/09/2026).
 *
 * CHƯA BIẾT không tồn tại ở đây: không có vận đơn nào ĐVVC đã cầm nghĩa là hàng còn ở shop, và việc
 * đó thuộc về người đang nói chuyện với khách.
 */
export function csDomainOf(kind: string, handedOff: boolean): CsDomain {
  const rule = CS_KIND_DOMAIN[kind as CsKind] ?? "BY_SHIPMENT";
  if (rule === "BY_SHIPMENT") return handedOff ? "LOGISTICS" : "CUSTOMER";
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
 * ═══ Ô LỌC "PHỤ TRÁCH" ĐI BẰNG KHOÁ TÀI KHOẢN, KHÔNG BẰNG Ô CHỮ ═══
 *
 * Giá trị của ô lọc là `users.id`, cộng đúng HAI rổ đặc biệt cho dòng không nối được về tài khoản:
 * bot (máy làm — không phải người, không phải "chưa ai") và tên gõ tay chưa nối (AGENTS.md mục
 * 34–36). Gom theo ô chữ như trước thì "Lan", "lan" và "Lan CS" là ba người và Bot ERP đứng chung
 * hàng với nhân viên.
 */
export const CS_ASSIGNEE_FACET_BOT = "__BOT__";
export const CS_ASSIGNEE_FACET_UNLINKED = "__UNLINKED__";
export const CS_ASSIGNEE_FACET_LABEL: Record<string, string> = {
  [CS_ASSIGNEE_FACET_BOT]: "Bot ERP (máy)",
  [CS_ASSIGNEE_FACET_UNLINKED]: "Tên gõ tay · chưa nối tài khoản",
};

/**
 * Hạn xử lý một case CSKH (giờ) — MỘT con số, lấy từ bảng hạn chung của hàng đợi việc.
 *
 * Nằm ở `lib/constants/*` chứ không ở `lib/queries/*` vì bảng CSKH (client component) cũng phải
 * biết dòng nào quá hạn để tô đỏ, mà client KHÔNG được import `lib/queries/*` (AGENTS.md mục 2).
 * `lib/queries/cs.ts` xuất lại đúng hằng này để nơi gọi cũ không phải sửa.
 */
export const CS_CASE_SLA_HOURS: number = requireSla(CASE_SLA_HOURS.CS_CASE);

/**
 * KHÔNG có con số dự phòng. `CASE_SLA_HOURS.CS_CASE` là hằng trong mã nguồn; nếu một ngày ai đó đặt
 * nó thành `null` ("loại việc này cố ý không đặt hạn") thì mọi phép tính quá hạn của CSKH phải đổ
 * ngay lúc nạp, chứ không được âm thầm chạy bằng một số gõ ở đây — hai nơi nói hai số khác nhau là
 * đúng thứ AGENTS.md mục 22 cấm.
 */
function requireSla(h: number | null): number {
  if (h === null) throw new Error("CASE_SLA_HOURS.CS_CASE đang là null — CSKH bắt buộc có hạn xử lý");
  return h;
}
