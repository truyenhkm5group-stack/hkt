/**
 * NHÀ CUNG CẤP GIẢ LẬP — không gọi mạng, không tốn tiền.
 *
 * Hai công dụng, cả hai đều thật:
 *  1. Chạy ERP khi CHƯA có khoá mô hình: dây chuyền vẫn chạy hết nấc luật, phần cần mô hình thì
 *     trả "không kết luận được" và lượt chạy chuyển người — đúng hành vi mong muốn, không phải
 *     một phiên bản cụt.
 *  2. Kiểm thử: tình huống mô hình trả rác, mô hình quá thời gian, mô hình lỗi đều dựng được một
 *     cách TẤT ĐỊNH, không cần mạng và không phập phù.
 */
import type { RouteTier } from "@/lib/constants/ai";
import { ModelTimeoutError, type CompletionRequest, type CompletionResult, type ModelProvider } from "@/lib/ai/providers/types";

export type StubScript = { text?: string; behavior?: "ok" | "timeout" | "error"; inputTokens?: number; outputTokens?: number };

const holder = globalThis as unknown as { __aiStub?: { queue: StubScript[]; calls: CompletionRequest[] } };
if (!holder.__aiStub) holder.__aiStub = { queue: [], calls: [] };
const state = holder.__aiStub;

/** Xếp sẵn câu trả lời cho các lần gọi kế tiếp (kiểm thử dùng). */
export function queueStubResponse(script: StubScript) {
  state.queue.push(script);
}

export function resetStub() {
  state.queue = [];
  state.calls = [];
}

/** Các yêu cầu đã gửi tới nhà cung cấp giả lập — để kiểm thử soi lời dặn có lọt bí mật không. */
export function stubCalls(): CompletionRequest[] {
  return state.calls;
}

export class StubProvider implements ModelProvider {
  readonly name = "stub";

  available() {
    return true;
  }

  defaultModel(tier: RouteTier) {
    return tier === "STRONG" ? "stub-strong" : "stub-economy";
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    state.calls.push(request);
    const script = state.queue.shift();
    if (script?.behavior === "timeout") throw new ModelTimeoutError("stub: quá thời gian phản hồi");
    if (script?.behavior === "error") throw new Error("stub: nhà cung cấp báo lỗi");
    // Không xếp sẵn gì ⇒ trả một câu KHÔNG kết luận được. Mặc định phải là "không biết",
    // vì một mặc định "biết" sẽ làm kiểm thử xanh trong khi thực tế chưa có mô hình nào chạy.
    const text = script?.text ?? JSON.stringify({ unsure: true, reason: "Chưa cấu hình mô hình thật" });
    return {
      text,
      inputTokens: script?.inputTokens ?? request.system.length + request.messages.reduce((s, m) => s + m.content.length, 0),
      outputTokens: script?.outputTokens ?? text.length,
      model: request.model || this.defaultModel("ECONOMY"),
      provider: this.name,
    };
  }
}
