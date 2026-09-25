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
 * ─── LUẬT PHÂN MIỀN — CHỦ SHOP CHỐT LẠI 25/09/2026 (tối) ───
 *
 *   **"Bàn care chỉ nhận sự cố của Viettel Post và case sai địa chỉ / SĐT. Mọi case khách khác về
 *   CSKH."**
 *
 *  · `DELIVERY_FAILED` luôn là `LOGISTICS`: nó sinh ra TỪ một vận đơn đã ở tay ĐVVC.
 *  · `WRONG_ADDRESS` / `WRONG_PHONE` đi theo KIỆN (`BY_SHIPMENT`): kiện ĐVVC đã cầm VÀ chưa chốt ⇒
 *    `LOGISTICS` (việc là sửa người nhận trên Viettel Post trước khi bưu tá đi phát); chưa giao
 *    hoặc đã chốt ⇒ `CUSTOMER`. "Đã cầm" = chặng thuộc `CARRIER_HANDOFF_STAGES` hoặc có mốc lấy
 *    hàng (AGENTS.md mục 41); "chờ lấy hàng", "lấy thất bại", "shop huỷ lấy" là CHƯA giao.
 *  · Mọi loại còn lại — khách muốn trả / không nhận, giục giao, khiếu nại, đổi size / mẫu, tư vấn,
 *    sai giá, xác nhận SĐT, khác — LUÔN là `CUSTOMER`, kể cả khi kiện đang trên đường.
 *
 * Vì sao đổi (bản sáng 25/09/2026 chia mọi case theo thời điểm bàn giao): chủ shop mở bàn care
 * thấy các cột "Đang vận chuyển" / "Đang đi giao" đầy thẻ "Khách khiếu nại", "Khách đổi size",
 * "Khách cần hỗ trợ", "Khách giục giao"… — kiện không có sự cố nào với ĐVVC, chỉ có một cuộc nói
 * chuyện với khách. Việc đó là của CSKH; kéo nó sang bàn care là làm "Cần care" và số vỡ SLA phình
 * lên bằng những việc bàn care không phải người làm.
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
  // Sai người nhận: kiện đang trên đường thì sửa trên Viettel Post ⇒ theo kiện (xem đầu tệp).
  WRONG_ADDRESS: "BY_SHIPMENT",
  WRONG_PHONE: "BY_SHIPMENT",
  // Mọi case khách khác: CSKH, kể cả khi kiện đang trên đường (chủ shop chốt lại 25/09/2026).
  URGE_DELIVERY: "CUSTOMER",
  RETURN: "CUSTOMER",
  ORDER_NOT_CREATED: "CUSTOMER",
  EXCHANGE_SIZE: "CUSTOMER",
  EXCHANGE_COLOR: "CUSTOMER",
  COMPLAINT: "CUSTOMER",
  SIZE_ADVICE: "CUSTOMER",
  WRONG_PRICE: "CUSTOMER",
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
