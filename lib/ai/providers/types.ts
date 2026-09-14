/**
 * Trừu tượng NHÀ CUNG CẤP MÔ HÌNH.
 *
 * Logic bán hàng không được biết tên một nhà cung cấp hay một tên mô hình nào. Nó chỉ nói
 * "chạy bước này ở nấc ECONOMY"; chọn nhà cung cấp và tên mô hình là việc của bộ định tuyến,
 * đọc từ cấu hình. Đổi nhà cung cấp = thêm một tệp trong thư mục này, không sửa một dòng nào
 * trong `lib/ai/agents/*`.
 */
import type { RouteTier } from "@/lib/constants/ai";

export type ModelMessage = { role: "user" | "assistant"; content: string };

export type CompletionRequest = {
  model: string;
  system: string;
  messages: ModelMessage[];
  maxOutputTokens: number;
  timeoutMs: number;
  /** Yêu cầu trả về JSON thuần. Nhà cung cấp nào không ép được thì vẫn phải cố gắng qua lời dặn. */
  json?: boolean;
};

export type CompletionResult = {
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
  provider: string;
};

export class ModelTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelTimeoutError";
  }
}

export class ModelUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelUnavailableError";
  }
}

export interface ModelProvider {
  readonly name: string;
  /** Đã đủ cấu hình để gọi thật chưa. Chưa đủ ⇒ bộ định tuyến bỏ qua nấc này, không ném lỗi. */
  available(): boolean;
  /** Tên mô hình mặc định cho một nấc; rỗng = nhà cung cấp này không phục vụ nấc đó. */
  defaultModel(tier: RouteTier): string;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}
