/**
 * KHAI BÁO NHÂN SỰ BÁN HÀNG — nhân sự AI đầu tiên chạy trên nền tảng.
 *
 * Khai báo này nằm trong mã nguồn để mỗi lần đổi lời dặn hay đổi danh sách công cụ đều phải đi
 * qua một pull request có người đọc. Nấc quyền hạn KHÔNG khai ở đây: nó là quyết định vận hành
 * của chủ shop, nằm trong CSDL và bảng `settings`.
 */
import { DEFAULT_ECONOMY_MODEL, DEFAULT_STRONG_MODEL } from "@/lib/constants/ai-model-pricing";
import type { AgentDefinition } from "@/lib/ai-workforce/registry";

export const SALES_AGENT: AgentDefinition = {
  key: "sales",
  name: "Nhân viên bán hàng AI",
  description: "Đọc hội thoại Pancake, dựng trạng thái bán hàng trong ERP và soạn câu trả lời gợi ý cho nhân viên. Ở nấc SHADOW không gửi gì cho khách.",
  version: 2,
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
    tiers: ["ECONOMY", "STRONG"],
    /*
      MÔ HÌNH LẤY TỪ BẢNG GIÁ, KHÔNG GÕ TAY Ở ĐÂY.

      Bản trước để trống và rơi về mô hình mặc định của nhà cung cấp. Với Anthropic, bậc mạnh mặc
      định là `claude-opus-5` — và nó KHÔNG có trong `MODEL_USD_PRICES`, nên mọi lượt leo nấc trả
      về chi phí CHƯA BIẾT. Một nhân sự chạy trên mô hình chưa khai giá thì "chi phí mỗi đơn"
      vĩnh viễn là một dấu gạch ngang, và cái trần chi phí mỗi ngày không bao giờ kiểm chứng được.

      Nên hai bậc trỏ thẳng vào hai hằng số của chính bảng giá. Đó không phải ghi cứng: thêm một
      mô hình vào bảng giá rồi đổi hai hằng số ấy là cả nhân sự đi theo, và `tests/sales-agent`
      bắt buộc mọi mô hình ở đây phải có đơn giá.

      Bậc rẻ gánh phần lớn lượt gọi (hiểu ý, bóc thực thể); bậc mạnh chỉ chạy khi bậc rẻ không đủ
      tự tin — đo 15/09/2026 là 0/18 lượt.
    */
    models: { ECONOMY: DEFAULT_ECONOMY_MODEL, STRONG: DEFAULT_STRONG_MODEL },
  },
  notes: "V0/V1 — chỉ chạy nấc SHADOW trên dữ liệu thật, dùng để đối chiếu với câu trả lời của nhân viên.",
};
