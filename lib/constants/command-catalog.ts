import type { Role } from "@/db/schema";

/**
 * ═══════════ SỔ LỆNH — "NGƯỜI DÙNG MUỐN LÀM GÌ", KHÔNG PHẢI "TÍNH NĂNG NẰM Ở MENU NÀO" ═══════════
 *
 * Chủ shop 09/10/2026: ERP có 86 mục menu trong 9 nhóm phòng ban; người dùng phải nhớ chức năng nằm ở nhóm nào. Tệp này
 * KHÔNG khai thêm trang nào và KHÔNG cấp quyền nào — sổ trang vẫn là `lib/constants/department-modules.ts` (AGENTS 69), và
 * mọi mục dưới đây chỉ hiện khi trang gốc (`base`) có trong menu đã lọc quyền của người xem (`allowedNavItems`). Nó chỉ
 * thêm ba thứ mà sổ trang không có:
 *
 *   1. BÍ DANH — chữ người dùng thật sự gõ ("đơn hoàn", "kết nối page", "bảng lương") ⇒ đúng trang.
 *   2. LỐI ĐI NHANH — một trang ĐÃ LỌC SẴN theo việc cần làm (đơn chưa giao ĐVVC, vận đơn chờ khách…). Chỉ dùng tham số
 *      lọc mà trang đích ĐÃ hiểu; bài kiểm `tests/command-catalog.test.ts` đối chiếu từng giá trị với hằng số của trang.
 *   3. TẠO MỚI — trang tạo có thật; cổng tạo của từng loại vẫn ở máy chủ (`lib/actions/quick-create.ts`).
 *
 * Cộng thêm MỤC CHÍNH THEO VAI TRÒ: ≤ 6 trang hằng ngày đứng thẳng trên thanh menu (một cú bấm), phần còn lại vào
 * "Tất cả chức năng". Không mất lối vào trang nào — chỉ bớt thứ chen vào việc hằng ngày.
 */

/** Từ người dùng hay gõ cho một trang. Khoá = href trong sổ trang. Chữ thường, có dấu — ô lệnh so khớp không phân biệt hoa thường. */
export const PAGE_ALIASES: Record<string, readonly string[]> = {
  "/": ["trang chủ", "tổng quan", "hôm nay", "dashboard", "lãi hôm nay", "doanh thu hôm nay"],
  "/alerts": ["cảnh báo", "việc cần làm", "cần xử lý"],
  "/work": ["công việc", "việc của tôi", "nhiệm vụ", "okr", "mục tiêu"],
  "/approvals": ["duyệt", "phê duyệt", "chờ duyệt"],
  "/cs": ["chăm sóc khách", "cskh", "tin nhắn", "trả lời khách"],
  "/orders": ["đơn", "đơn hàng", "danh sách đơn", "tìm đơn"],
  "/ai/sales-chatbot/inbox": ["hộp thư", "inbox", "tin nhắn", "trả lời khách", "chat", "messenger"],
  "/ai/sales-chatbot": ["chatbot", "bot", "ai bán hàng", "câu trả lời mẫu", "cài chatbot"],
  "/customers": ["khách", "khách hàng", "tìm khách", "sđt", "số điện thoại"],
  "/customers/receivables": ["công nợ", "nợ khách"],
  "/customers/reorder": ["mua lại", "nhắc mua lại"],
  "/ads": ["quảng cáo", "facebook ads", "chi phí quảng cáo", "roas"],
  "/marketing/creatives": ["media", "ảnh", "video", "thư viện"],
  "/marketing/fanpages": ["fanpage", "page", "quy kết marketing"],
  "/shipments": ["vận đơn", "giao hàng", "giao vận", "vận chuyển", "care", "chăm sóc vận đơn", "vận đơn có vấn đề", "phát thất bại"],
  "/orders/self-delivery": ["tự giao", "shipper riêng"],
  "/returns": ["đổi trả", "phiếu đổi"],
  "/reports/returns": ["tỷ lệ hoàn", "tỷ lệ giao thành công", "gtc"],
  "/inventory/packing": ["đóng gói", "đóng hàng", "lượt đóng"],
  "/products": ["sản phẩm", "tồn kho", "còn bao nhiêu", "hàng còn", "sku", "mẫu mã", "kho"],
  "/inventory/receipts": ["nhập hàng", "phiếu nhập", "kiểm kê", "phiếu kho"],
  "/inventory/returns": ["hàng hoàn", "kiểm đếm hàng hoàn", "nhận hàng hoàn"],
  "/inventory": ["nhật ký kho", "xuất nhập tồn"],
  "/inventory/shortage": ["thiếu hàng", "hết hàng", "sắp hết", "chờ hàng"],
  "/inventory/planning": ["kế hoạch sản xuất", "đặt hàng sản xuất"],
  "/inventory/workshop": ["xưởng", "đặt xưởng"],
  "/finance": ["tài chính", "tiền"],
  "/cod": ["cod", "đối soát", "thu hộ", "tiền cod"],
  "/bank": ["ngân hàng", "sao kê", "sổ ngân hàng"],
  "/expenses": ["chi phí", "khoản chi"],
  "/reports": ["báo cáo", "lợi nhuận", "lãi", "lỗ", "lãi lỗ", "báo cáo marketing"],
  "/reports/cashflow": ["dòng tiền"],
  "/payroll": ["lương", "bảng lương", "hoa hồng", "phiếu lương"],
  "/cockpit": ["quyết định", "cần anh quyết"],
  "/integrations": ["kết nối", "kết nối page", "kết nối facebook", "pancake", "viettel post", "tích hợp"],
  "/settings/users": ["nhân viên", "thêm nhân viên", "tài khoản", "người dùng", "phân quyền"],
  "/settings/notifications": ["thông báo nhóm", "lark", "telegram"],
  "/setup": ["thiết lập", "xuất bản"],
};

/**
 * LỐI ĐI NHANH — danh sách ĐÃ LỌC THEO VIỆC CẦN LÀM. `base` là trang trong sổ trang (quyết định quyền); `href` chỉ
 * mang tham số mà trang ấy đọc. Thứ tự = thứ tự hiện khi ô lệnh còn trống.
 */
export type QuickView = { key: string; label: string; hint: string; base: string; href: string; keywords: readonly string[] };

export const QUICK_VIEWS: readonly QuickView[] = [
  { key: "inbox-unanswered", label: "Khách đang chờ trả lời", hint: "Hộp thư · chưa trả lời", base: "/ai/sales-chatbot/inbox", href: "/ai/sales-chatbot/inbox?f=UNANSWERED", keywords: ["chờ trả lời", "chưa trả lời", "khách chờ"] },
  { key: "inbox-needs-human", label: "Hội thoại cần người", hint: "Hộp thư · AI chuyển cho người", base: "/ai/sales-chatbot/inbox", href: "/ai/sales-chatbot/inbox?f=NEEDS_HUMAN", keywords: ["cần người", "ai chuyển"] },
  { key: "orders-review", label: "Đơn cần người kiểm", hint: "Đơn hàng · cần xác nhận", base: "/orders", href: "/orders?review=flagged", keywords: ["xác nhận đơn", "đơn cần kiểm", "cần xác nhận"] },
  { key: "orders-not-shipped", label: "Đơn chưa gửi ĐVVC", hint: "Đơn hàng · chưa bàn giao", base: "/orders", href: "/orders?fulfillment=NOT_SHIPPED", keywords: ["chưa gửi", "chưa giao", "đơn chưa gửi", "chưa bàn giao"] },
  { key: "orders-bad-address", label: "Đơn sai / thiếu địa chỉ", hint: "Đơn hàng · địa chỉ chưa chuẩn hoá", base: "/orders", href: "/orders?address=unnormalized", keywords: ["địa chỉ", "sai địa chỉ", "thiếu địa chỉ"] },
  { key: "orders-returning", label: "Đơn đang hoàn", hint: "Đơn hàng · đang chuyển hoàn", base: "/orders", href: "/orders?fulfillment=RETURNING", keywords: ["đơn hoàn", "đang hoàn", "hoàn hàng"] },
  { key: "orders-returned", label: "Đơn đã hoàn về shop", hint: "Đơn hàng · đã hoàn", base: "/orders", href: "/orders?fulfillment=RETURNED", keywords: ["đơn hoàn", "đã hoàn", "hoàn về"] },
  { key: "orders-today", label: "Đơn hôm nay", hint: "Đơn hàng · hôm nay", base: "/orders", href: "/orders?period=today", keywords: ["hôm nay", "đơn mới"] },
  { key: "shipments-care", label: "Vận đơn có vấn đề", hint: "Giao vận · cần chăm sóc", base: "/shipments", href: "/shipments", keywords: ["phát thất bại", "vận đơn lỗi", "có vấn đề", "bất thường"] },
  { key: "shipments-waiting", label: "Vận đơn chờ khách phản hồi", hint: "Giao vận · đang chờ", base: "/shipments", href: "/shipments?view=waiting", keywords: ["chờ khách", "hẹn giao lại"] },
  { key: "stock-shortage", label: "Hàng thiếu cho đơn đã chốt", hint: "Sản xuất · thiếu hàng", base: "/inventory/shortage", href: "/inventory/shortage", keywords: ["hết hàng", "sắp hết", "thiếu hàng"] },
  { key: "profit-today", label: "Lãi hôm nay", hint: "Báo cáo lợi nhuận · hôm nay", base: "/reports", href: "/reports?period=today", keywords: ["lãi hôm nay", "lợi nhuận hôm nay"] },
];

/** TẠO MỚI — mỗi mục là một trang tạo có thật; `base` quyết định có hiện cho người này không, cổng tạo vẫn ở máy chủ. */
export type CreateKey = "order" | "customer" | "product" | "receipt" | "expense" | "user";
export type CreateAction = { key: CreateKey; label: string; base: string; href: string; keywords: readonly string[] };

export const CREATE_ACTIONS: readonly CreateAction[] = [
  { key: "order", label: "Đơn hàng", base: "/orders", href: "/orders/new", keywords: ["tạo đơn", "lên đơn", "đơn mới"] },
  { key: "customer", label: "Khách hàng", base: "/customers", href: "/customers/new", keywords: ["tạo khách", "thêm khách", "khách mới"] },
  { key: "product", label: "Sản phẩm", base: "/products", href: "/products/new", keywords: ["thêm sản phẩm", "tạo sản phẩm", "sản phẩm mới"] },
  { key: "receipt", label: "Phiếu nhập kho", base: "/inventory/receipts", href: "/inventory/receipts", keywords: ["nhập hàng", "phiếu nhập", "phiếu kho"] },
  { key: "expense", label: "Khoản chi", base: "/expenses", href: "/expenses", keywords: ["thêm chi phí", "ghi chi phí", "khoản chi"] },
  { key: "user", label: "Nhân viên", base: "/settings/users", href: "/settings/users", keywords: ["thêm nhân viên", "tạo tài khoản"] },
];

/**
 * MỤC CHÍNH THEO VAI TRÒ — ≤ 6 trang đứng thẳng trên thanh menu. Vai trò chỉ SẮP XẾP, không cấp quyền: mục nào người
 * này không được vào thì bị lọc bỏ (cùng luật `allowedNavItems`), trang khác vẫn ở "Tất cả chức năng" và ô lệnh.
 */
export const PRIMARY_NAV_BY_ROLE: Record<Role, readonly string[]> = {
  ADMIN: ["/", "/ai/sales-chatbot/inbox", "/orders", "/customers", "/shipments", "/reports"],
  MANAGER: ["/", "/ai/sales-chatbot/inbox", "/orders", "/customers", "/shipments", "/reports"],
  LEADER: ["/", "/work", "/orders", "/customers", "/shipments", "/alerts"],
  CS: ["/", "/ai/sales-chatbot/inbox", "/cs", "/orders", "/customers", "/shipments"],
  WAREHOUSE: ["/", "/inventory/packing", "/products", "/inventory/receipts", "/inventory/returns", "/shipments"],
  MARKETING: ["/", "/ads", "/marketing/creatives", "/ideas", "/reports", "/orders"],
  ACCOUNTANT: ["/", "/finance", "/cod", "/bank", "/expenses", "/payroll"],
  VIEWER: ["/", "/orders", "/customers", "/reports"],
};

/** Nhãn ngắn cho mục chính (thanh menu không đủ chỗ cho "Vận đơn & care"). Không có ở đây ⇒ dùng nhãn của sổ trang. */
export const PRIMARY_NAV_LABEL: Record<string, string> = {
  "/": "Hôm nay",
  "/ai/sales-chatbot/inbox": "Hộp thư",
  "/cs": "CSKH",
  "/shipments": "Giao vận",
  "/reports": "Báo cáo",
  "/work": "Công việc",
  "/alerts": "Cần xử lý",
  "/products": "Sản phẩm & kho",
  "/inventory/packing": "Đóng gói",
  "/inventory/receipts": "Nhập hàng",
  "/inventory/returns": "Hàng hoàn",
  "/marketing/creatives": "Media",
  "/ideas": "Ý tưởng",
  "/finance": "Tài chính",
  "/cod": "Đối soát COD",
  "/bank": "Ngân hàng",
  "/expenses": "Chi phí",
  "/payroll": "Lương",
};

export const MAX_PRIMARY_NAV = 6;

/** Mục chính của một người: theo vai trò, chỉ giữ trang người đó vào được, tối đa `MAX_PRIMARY_NAV`. Hàm THUẦN. */
export function primaryNavFor(role: Role, allowed: ReadonlySet<string>): string[] {
  return (PRIMARY_NAV_BY_ROLE[role] ?? PRIMARY_NAV_BY_ROLE.VIEWER).filter((href) => allowed.has(href)).slice(0, MAX_PRIMARY_NAV);
}

/** Chuỗi để ô lệnh so khớp một trang: nhãn + nhóm + bí danh. */
export function pageSearchText(href: string, label: string, group: string): string {
  return [label, group, ...(PAGE_ALIASES[href] ?? [])].join(" ");
}
