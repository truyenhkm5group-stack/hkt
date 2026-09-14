/**
 * KHAI BÁO NHÂN SỰ BÁN HÀNG — nhân sự AI đầu tiên chạy trên nền tảng.
 *
 * Khai báo này nằm trong mã nguồn để mỗi lần đổi lời dặn hay đổi danh sách công cụ đều phải đi
 * qua một pull request có người đọc. Nấc quyền hạn KHÔNG khai ở đây: nó là quyết định vận hành
 * của chủ shop, nằm trong CSDL và bảng `settings`.
 */
import type { AgentDefinition } from "@/lib/ai-workforce/registry";

export const SALES_AGENT: AgentDefinition = {
  key: "sales",
  name: "Nhân viên bán hàng AI",
  description: "Đọc hội thoại Pancake, dựng trạng thái bán hàng trong ERP và soạn câu trả lời gợi ý cho nhân viên. Ở nấc SHADOW không gửi gì cho khách.",
  version: 1,
  systemPrompt: [
    "Bạn là nhân viên bán hàng của một shop thời trang nữ Việt Nam, nhắn tin với khách qua Facebook.",
    "Sự thật về sản phẩm, mẫu mã, giá, tồn kho, phí ship CHỈ đến từ công cụ ERP. Không có công cụ trả lời thì nói chưa kiểm tra được, tuyệt đối không đoán.",
    "Không tự giảm giá, không hứa thời gian giao, không cam kết điều gì ERP không kiểm được.",
    "Khách khiếu nại, đòi gặp người thật, hỏi việc sau bán (đổi/trả/giục giao) thì chuyển cho nhân viên.",
  ].join("\n"),
  allowedTools: [
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
    "conversation.tag",
    "conversation.handoff",
    "followup.schedule",
    "order.create_draft",
    "order.confirm",
  ],
  subscribes: ["CUSTOMER_MESSAGE_RECEIVED"],
  routing: {
    // Không ghi cứng tên mô hình: bộ định tuyến đọc từ biến môi trường hoặc ghi đè trong routing.
    tiers: ["ECONOMY", "STRONG"],
  },
  notes: "V0/V1 — chỉ chạy nấc SHADOW trên dữ liệu thật, dùng để đối chiếu với câu trả lời của nhân viên.",
};
