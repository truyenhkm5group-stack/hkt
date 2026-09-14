/**
 * ═══════════ HÀNH ĐỘNG NHANH TRÊN MỘT DÒNG VIỆC ═══════════
 *
 * Luật số một, và nó là lý do tệp này tồn tại: **KHÔNG CÓ NÚT GIẢ.**
 *
 * Một nút "Tắt chiến dịch" mà backend không tắt được chiến dịch thì tệ hơn hẳn việc không có nút:
 * người bấm tin là đã xong, và tiền vẫn chảy. Nên mỗi hành động ở đây khai rõ nó chạy bằng gì:
 *
 *  · `LINK`   — chỉ mở một đường dẫn. Không ghi gì.
 *  · `DOMAIN` — gọi một Server Action CÓ THẬT của miền nghiệp vụ. `actionModule`/`actionName` trỏ
 *               tới đúng hàm đó, và `tests/work-os.test.ts` đọc mã nguồn để kiểm hàm tồn tại.
 *  · `WORK`   — ghi vào lớp công việc (`work_items`): người nhận, hạn, hoãn, ghi chú, lý do chặn.
 *               KHÔNG bao giờ đụng tới trạng thái nghiệp vụ.
 *
 * Hệ quả của `DOMAIN`: bấm "Đã xử lý" trên hàng đợi đi qua ĐÚNG con đường mà trang CSKH đi — cùng
 * kiểm quyền, cùng zod, cùng `audit()`, cùng lịch sử. Không có đường tắt nào "đánh dấu xong".
 */

export const WORK_ACTION_MODES = ["LINK", "DOMAIN", "WORK"] as const;
export type WorkActionMode = (typeof WORK_ACTION_MODES)[number];

export type WorkActionSpec = {
  key: string;
  label: string;
  mode: WorkActionMode;
  hint: string;
  /** Chỉ với `DOMAIN`: tệp Server Action và tên hàm được gọi. */
  actionModule?: string;
  actionName?: string;
  /** Quyền tối thiểu để nút hiện. Rỗng = ai vào được hàng đợi là bấm được. */
  permission?: string;
};

export const WORK_ACTION_KEYS = [
  // ─── chung cho mọi việc (lớp công việc) ───
  "WORK_CLAIM",
  "WORK_ASSIGN",
  "WORK_NOTE",
  "WORK_SNOOZE",
  "WORK_PRIORITY",
  "WORK_DUE",
  "WORK_BLOCK",
  "WORK_STATUS",
  // ─── CSKH / bán hàng ───
  "CS_CHAT",
  "CS_OPEN_POS",
  "CS_CLAIM",
  "CS_CONTACTED",
  "CS_DONE",
  "CS_SNOOZE",
  // ─── giao vận ───
  "CARE_OPEN",
  "CARE_NOTE",
  "CARE_FOLLOW_UP",
  "CARE_OWNER",
  "CARE_RESOLVE",
  "CARRIER_REQUEST",
  // ─── kho ───
  "RETURN_RECEIVE",
  "RETURN_OPEN_INSPECTION",
  // ─── tài chính ───
  "BANK_CLASSIFY",
  "BANK_LINK",
  "BANK_OPEN",
  "COD_OPEN",
  // ─── marketing ───
  "ADS_OPEN",
  // ─── điều hướng chung ───
  "OPEN_ORDER",
  "OPEN_SHIPMENT",
  "OPEN_SOURCE",
] as const;
export type WorkActionKey = (typeof WORK_ACTION_KEYS)[number];

export const WORK_ACTION: Record<WorkActionKey, WorkActionSpec> = {
  WORK_CLAIM: { key: "WORK_CLAIM", label: "Nhận việc", mode: "WORK", hint: "Ghi tên mình vào việc này. Không đụng trạng thái nghiệp vụ ở nguồn." },
  WORK_ASSIGN: { key: "WORK_ASSIGN", label: "Giao cho", mode: "WORK", hint: "Giao việc cho một người trong phòng.", permission: "work:assign" },
  WORK_NOTE: { key: "WORK_NOTE", label: "Ghi chú", mode: "WORK", hint: "Thêm một dòng vào lịch sử việc — chỉ thêm, không sửa, không xoá." },
  WORK_SNOOZE: { key: "WORK_SNOOZE", label: "Hoãn tới", mode: "WORK", hint: "Việc không biến mất, nó chỉ thôi nổi lên trước giờ đã hẹn." },
  WORK_PRIORITY: { key: "WORK_PRIORITY", label: "Đổi mức ưu tiên", mode: "WORK", hint: "Đặt tay đè lên mức ưu tiên tính được. Ghi lại người đặt và lúc đặt." },
  WORK_DUE: { key: "WORK_DUE", label: "Đặt hạn", mode: "WORK", hint: "Hạn đặt tay. Khác SLA của loại việc — SLA là luật, hạn này là cam kết của người làm." },
  WORK_BLOCK: { key: "WORK_BLOCK", label: "Báo bị chặn", mode: "WORK", hint: "Bắt buộc kèm lý do. Việc bị chặn là nút thắt trưởng phòng phải gỡ." },
  WORK_STATUS: { key: "WORK_STATUS", label: "Đổi trạng thái", mode: "WORK", hint: "Chỉ với việc tay / việc định kỳ — việc thuộc miền nghiệp vụ đổi trạng thái tại nguồn." },

  CS_CHAT: { key: "CS_CHAT", label: "Chat khách", mode: "LINK", hint: "Mở đúng hội thoại Pancake của khách." },
  CS_OPEN_POS: { key: "CS_OPEN_POS", label: "Tạo / mở đơn", mode: "LINK", hint: "Mở POS Pancake để lên đơn. ERP không tự tạo đơn vì chưa có mẫu mã đã chốt." },
  CS_CLAIM: { key: "CS_CLAIM", label: "Nhận việc", mode: "DOMAIN", hint: "Nhận case và chuyển sang Đang xử lý.", actionModule: "lib/actions/cs.ts", actionName: "csQuickAction", permission: "cs:manage" },
  CS_CONTACTED: { key: "CS_CONTACTED", label: "Đã liên hệ", mode: "DOMAIN", hint: "Ghi nhận đã gọi / nhắn khách.", actionModule: "lib/actions/cs.ts", actionName: "csQuickAction", permission: "cs:manage" },
  CS_DONE: { key: "CS_DONE", label: "Hoàn thành", mode: "DOMAIN", hint: "Đóng case CSKH tại nguồn.", actionModule: "lib/actions/cs.ts", actionName: "csQuickAction", permission: "cs:manage" },
  CS_SNOOZE: { key: "CS_SNOOZE", label: "Hẹn lại", mode: "DOMAIN", hint: "Hẹn giờ quay lại case — dùng chính cơ chế hẹn của trang CSKH.", actionModule: "lib/actions/cs.ts", actionName: "csQuickAction", permission: "cs:manage" },

  CARE_OPEN: { key: "CARE_OPEN", label: "Mở vận đơn", mode: "LINK", hint: "Mở bàn care của đúng kiện hàng." },
  CARE_NOTE: { key: "CARE_NOTE", label: "Ghi chú", mode: "DOMAIN", hint: "Ghi một dòng vào lịch sử care.", actionModule: "lib/actions/care-workbench.ts", actionName: "addCareNote", permission: "shipments:view" },
  CARE_FOLLOW_UP: { key: "CARE_FOLLOW_UP", label: "Hẹn care", mode: "DOMAIN", hint: "Hẹn theo dõi lại kiện.", actionModule: "lib/actions/care-workbench.ts", actionName: "setCareFollowUp", permission: "shipments:view" },
  CARE_OWNER: { key: "CARE_OWNER", label: "Giao owner", mode: "DOMAIN", hint: "Đổi người phụ trách kiện.", actionModule: "lib/actions/care-workbench.ts", actionName: "setCareOwner", permission: "shipments:view" },
  CARE_RESOLVE: { key: "CARE_RESOLVE", label: "Đóng care", mode: "DOMAIN", hint: "Đóng ca care. KHÔNG đổi trạng thái ĐVVC của kiện.", actionModule: "lib/actions/care-workbench.ts", actionName: "setCareStatus", permission: "shipments:view" },
  CARRIER_REQUEST: { key: "CARRIER_REQUEST", label: "Gửi ĐVVC", mode: "DOMAIN", hint: "Phát tiếp / duyệt hoàn / huỷ — chỉ hiện khi tài khoản API có quyền trên kiện đó.", actionModule: "lib/actions/care-workbench.ts", actionName: "requestCarrierAction", permission: "shipments:manage" },

  RETURN_RECEIVE: { key: "RETURN_RECEIVE", label: "Nhận kiện", mode: "DOMAIN", hint: "Xác nhận kho đã cầm kiện hoàn trên tay. Chưa phải tái nhập tồn.", actionModule: "lib/actions/returns-warehouse.ts", actionName: "confirmReturnReceived", permission: "inventory:write" },
  RETURN_OPEN_INSPECTION: { key: "RETURN_OPEN_INSPECTION", label: "Kiểm hàng", mode: "LINK", hint: "Mở trạm kiểm đếm hàng hoàn để đếm thực tế và lập phiếu tái nhập." },

  BANK_CLASSIFY: { key: "BANK_CLASSIFY", label: "Phân loại", mode: "DOMAIN", hint: "Gán nhóm kế toán cho dòng tiền.", actionModule: "lib/actions/bank.ts", actionName: "classifyBankTransactions", permission: "bank:write" },
  BANK_LINK: { key: "BANK_LINK", label: "Nối chứng từ", mode: "DOMAIN", hint: "Nối dòng tiền với chi phí / đợt COD / kỳ lương.", actionModule: "lib/actions/bank.ts", actionName: "linkBankTransaction", permission: "bank:write" },
  BANK_OPEN: { key: "BANK_OPEN", label: "Mở sổ ngân hàng", mode: "LINK", hint: "Mở đúng dòng trên sổ ngân hàng." },
  COD_OPEN: { key: "COD_OPEN", label: "Mở đối soát COD", mode: "LINK", hint: "Mở trang đối soát COD." },

  ADS_OPEN: { key: "ADS_OPEN", label: "Mở quảng cáo", mode: "LINK", hint: "Mở màn ra quyết định quảng cáo ở đúng dòng." },

  OPEN_ORDER: { key: "OPEN_ORDER", label: "Mở đơn", mode: "LINK", hint: "Mở đơn hàng trong ERP." },
  OPEN_SHIPMENT: { key: "OPEN_SHIPMENT", label: "Mở vận đơn", mode: "LINK", hint: "Mở vận đơn trong ERP." },
  OPEN_SOURCE: { key: "OPEN_SOURCE", label: "Mở nguồn", mode: "LINK", hint: "Mở đúng chỗ sinh ra việc này." },
};

/** Hành động GHI vào lớp công việc — không đụng nghiệp vụ. */
export const WORK_LAYER_ACTIONS: WorkActionKey[] = WORK_ACTION_KEYS.filter((k) => WORK_ACTION[k].mode === "WORK");

/** Hành động gọi Server Action của miền nghiệp vụ. */
export const WORK_DOMAIN_ACTIONS: WorkActionKey[] = WORK_ACTION_KEYS.filter((k) => WORK_ACTION[k].mode === "DOMAIN");

/**
 * Hành động chung, thêm vào MỌI việc bất kể nguồn. Cố ý nhỏ: bốn thứ một người luôn cần làm được
 * với bất kỳ việc nào — cầm lấy, ghi lại, hoãn, hoặc nói mình đang bị chặn.
 */
export const WORK_COMMON_ACTIONS: WorkActionKey[] = ["WORK_CLAIM", "WORK_NOTE", "WORK_SNOOZE", "WORK_BLOCK"];

export function isWorkActionKey(k: string): k is WorkActionKey {
  return (WORK_ACTION_KEYS as readonly string[]).includes(k);
}
