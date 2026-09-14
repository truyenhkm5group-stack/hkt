/**
 * ───────────── SỔ ĐĂNG KÝ CÔNG CỤ ERP CHO NHÂN SỰ AI ─────────────
 *
 * Nhân sự AI KHÔNG có kết nối CSDL. Mọi thứ nó biết về shop đều đi qua đúng danh sách dưới đây,
 * và mỗi công cụ khai rõ: đọc hay ghi, cần quyền gì, ai là nguồn sự thật đằng sau nó.
 *
 * BA ĐIỀU KHÔNG THƯƠNG LƯỢNG
 *
 * 1. KHÔNG có công cụ nào sửa giá, sửa tồn, xoá đơn, đánh dấu giao thành công, hay đụng vào
 *    trạng thái tiền / kế toán. Không phải "chưa làm" — là KHÔNG ĐƯỢC CÓ. `tests/ai-platform.test.ts`
 *    quét sổ này và bắt lỗi nếu một công cụ như thế xuất hiện.
 * 2. Công cụ GHI chỉ chạy khi nhân sự AI đạt nấc quyền hạn khai ở `minMode`. Ở nấc `SHADOW`
 *    mọi công cụ ghi đều bị từ chối và lần từ chối đó được ghi lại — im lặng bỏ qua thì sau này
 *    không ai biết con bot đã ĐỊNH làm gì.
 * 3. Giá tiền, phí ship, tồn kho luôn do MÁY CHỦ tính từ nguồn sự thật. Con số do mô hình nói ra
 *    chỉ là văn bản; nếu lệch với số máy chủ tính thì lượt chạy phải chuyển người.
 */
import type { AgentMode } from "@/lib/constants/ai";

export const TOOL_NAMES = [
  "product.search",
  "product.get",
  "product.get_variants",
  "pricing.get",
  "promotion.get",
  "inventory.check",
  "size.recommend",
  "shipping.policy",
  "shipping.calculate",
  "customer.get",
  "customer.update",
  "order.create_draft",
  "order.confirm",
  "conversation.tag",
  "conversation.handoff",
  "followup.schedule",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export type ToolKind = "READ" | "WRITE";

export type ToolDeclaration = {
  /** ĐỌC = không đổi gì trong ERP. GHI = có ghi, luôn phải qua cổng quyền. */
  kind: ToolKind;
  /** Nấc quyền hạn tối thiểu của nhân sự AI để công cụ này chạy thật. */
  minMode: AgentMode;
  /** Quyền ERP mà NGƯỜI phải có để làm cùng việc này bằng tay — nối AI vào đúng ma trận quyền đang chạy. */
  permission: string;
  /** Nguồn sự thật đằng sau công cụ: đọc lại được thì mới tranh luận được khi số liệu lệch. */
  source: string;
  label: string;
};

export const TOOL_CATALOG: Record<ToolName, ToolDeclaration> = {
  "product.search": { kind: "READ", minMode: "SHADOW", permission: "products:view", source: "products + product_variants (đồng bộ từ Pancake)", label: "Tìm sản phẩm" },
  "product.get": { kind: "READ", minMode: "SHADOW", permission: "products:view", source: "products", label: "Chi tiết sản phẩm" },
  "product.get_variants": { kind: "READ", minMode: "SHADOW", permission: "products:view", source: "product_variants", label: "Mẫu mã của sản phẩm" },
  "pricing.get": { kind: "READ", minMode: "SHADOW", permission: "products:view", source: "product_variants.retail_price + cấu hình landing.config", label: "Giá bán do máy chủ tính" },
  "promotion.get": { kind: "READ", minMode: "SHADOW", permission: "products:view", source: "landing.config (giá gói / free ship)", label: "Ưu đãi đang chạy" },
  "inventory.check": { kind: "READ", minMode: "SHADOW", permission: "products:view", source: "lib/queries/stock.ts — sổ kho ERP", label: "Kiểm tồn khả dụng" },
  "size.recommend": { kind: "READ", minMode: "SHADOW", permission: "products:view", source: "bảng size khai trong ai.sizeChart + mẫu mã đang bán", label: "Gợi ý size" },
  "shipping.policy": { kind: "READ", minMode: "SHADOW", permission: "products:view", source: "landing.config", label: "Chính sách ship" },
  "shipping.calculate": { kind: "READ", minMode: "SHADOW", permission: "products:view", source: "landingShippingFee() — cùng hàm trang Landing dùng", label: "Tính phí ship" },
  "customer.get": { kind: "READ", minMode: "SHADOW", permission: "customers:view", source: "customers + orders", label: "Thông tin khách" },
  "customer.update": { kind: "WRITE", minMode: "COPILOT", permission: "cs:manage", source: "customers (chỉ tên / SĐT phụ / địa chỉ giao)", label: "Cập nhật thông tin khách" },
  "order.create_draft": { kind: "WRITE", minMode: "COPILOT", permission: "landing:manage", source: "Pancake POS createOrder (trạng thái Mới = đơn nháp)", label: "Tạo đơn nháp" },
  "order.confirm": { kind: "WRITE", minMode: "AUTO", permission: "landing:manage", source: "Pancake POS — nhân viên chốt", label: "Chốt đơn" },
  "conversation.tag": { kind: "WRITE", minMode: "SHADOW", permission: "cs:view", source: "sales_conversations.tags (nhãn nội bộ ERP, không ghi ngược Pancake)", label: "Gắn nhãn hội thoại" },
  "conversation.handoff": { kind: "WRITE", minMode: "SHADOW", permission: "cs:view", source: "sales_conversations.human_takeover_at", label: "Chuyển người" },
  "followup.schedule": { kind: "WRITE", minMode: "SHADOW", permission: "outreach:view", source: "sales_followups (danh sách chờ, không tự gửi)", label: "Hẹn chăm sóc lại" },
};


/** Mảnh tên bị cấm xuất hiện trong tên công cụ — chặn ngay ở mức đặt tên. */
export const FORBIDDEN_TOOL_PATTERNS = [
  /price\.(set|update|write)/i,
  /inventory\.(set|update|adjust|write)/i,
  /order\.(delete|remove)/i,
  /shipment\.(deliver|mark|update)/i,
  /(payment|cod|accounting|payroll|expense)\./i,
] as const;

/** Ba hạng kết quả của một lần gọi công cụ. `DENIED` là kết quả hợp lệ, không phải lỗi hệ thống. */
export const TOOL_OUTCOMES = ["OK", "DENIED", "ERROR", "TIMEOUT"] as const;
export type ToolOutcome = (typeof TOOL_OUTCOMES)[number];

export const TOOL_OUTCOME_LABEL: Record<ToolOutcome, string> = {
  OK: "Chạy được",
  DENIED: "Bị cổng quyền từ chối",
  ERROR: "Lỗi",
  TIMEOUT: "Quá thời gian",
};

/** Trần thời gian một lần gọi công cụ. Quá hạn là TIMEOUT, không phải "kết quả rỗng". */
export const TOOL_TIMEOUT_MS = 8_000;
