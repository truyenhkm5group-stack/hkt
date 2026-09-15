import { aiEnv } from "@/lib/ai-workforce/config";
import { AnthropicProvider } from "@/lib/ai-workforce/providers/anthropic";
import { ErpSharedProvider } from "@/lib/ai-workforce/providers/erp-shared";
import { StubProvider } from "@/lib/ai-workforce/providers/stub";
import type { ModelProvider } from "@/lib/ai-workforce/providers/types";

const providers = new Map<string, ModelProvider>();

function register(provider: ModelProvider) {
  providers.set(provider.name, provider);
}

register(new StubProvider());
register(new ErpSharedProvider());
register(new AnthropicProvider());

/**
 * Lấy một nhà cung cấp theo tên. Tên lạ ⇒ null (bộ định tuyến sẽ leo nấc hoặc chuyển người),
 * KHÔNG âm thầm rơi về một nhà cung cấp khác — chi phí và chất lượng khác nhau thì người dùng
 * phải biết mình đang chạy trên cái gì.
 */
export function getProvider(name: string): ModelProvider | null {
  return providers.get(name) ?? null;
}

/**
 * Nhà cung cấp mặc định — ƯU TIÊN TẦNG AI CÓ SẴN CỦA ERP.
 *
 * Thứ tự: khai tay (`AI_WORKFORCE_PROVIDER`) → tầng ERP nếu đã cấu hình → khoá riêng của nhân sự
 * AI nếu có → `stub` (không gọi mạng).
 *
 * Bậc "tầng ERP" đứng TRƯỚC khoá riêng là điều quan trọng nhất ở đây: shop đã có một khoá OpenAI
 * đang chạy thật cho AI Copilot, nên nhân sự bán hàng không có lý do gì đòi khoá thứ hai. Giữ
 * `anthropic` phía sau làm đường lui cho trường hợp chủ shop muốn tách hẳn hai hoá đơn — nhưng đó
 * là một lựa chọn phải KHAI, không phải mặc định.
 */
export function defaultProviderName(): string {
  // KHAI TAY THẮNG TUYỆT ĐỐI, kể cả khi khai là `stub`. Bản trước loại trừ `stub` khỏi nhánh này
  // (di sản từ thời `aiEnv.provider` mặc định là `stub`), nên người vận hành đặt `stub` để TẮT
  // hẳn lượt gọi mô hình vẫn bị kéo sang tầng ERP — một công tắc tắt mà không tắt.
  const khai = aiEnv.provider;
  if (khai) return khai;
  if (new ErpSharedProvider().available()) return "erp";
  if (aiEnv.apiKey) return "anthropic";
  return "stub";
}

export function providerNames(): string[] {
  return [...providers.keys()];
}
