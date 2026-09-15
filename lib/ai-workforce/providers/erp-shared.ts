/**
 * NHÂN SỰ BÁN HÀNG DÙNG LẠI TẦNG AI CÓ SẴN CỦA ERP — không dựng tích hợp thứ hai.
 *
 * ERP đã có một lớp provider đầy đủ ở `lib/ai/`: SDK chính thức của OpenAI và Anthropic, số lần
 * thử lại, trần thời gian, đọc khoá từ môi trường, đếm cả token đọc từ đệm, và một bộ chọn mô hình
 * theo bậc việc (`lib/ai/router.ts`). AI Copilot đang chạy thật trên production bằng lớp đó.
 *
 * ─── VÌ SAO TỆP NÀY TỒN TẠI ───
 *
 * Bản đầu của nhân sự AI tự viết một client gọi thẳng Messages API bằng `fetch`, với KHOÁ RIÊNG
 * (`AI_API_KEY`) và BẢNG MÔ HÌNH RIÊNG. Nghĩa là cùng một shop sẽ có hai khoá phải giữ, hai chỗ
 * phải đổi khi đổi mô hình, hai cách xử lý 429, và hai bảng giá có thể nói hai con số khác nhau về
 * cùng một lượt gọi. Không có lý do kiến trúc nào đòi điều đó.
 *
 * Tệp này là CÁI CẦU: nó nhận yêu cầu theo hình dạng của nhân sự AI và chuyển sang hình dạng của
 * lớp ERP. Nhờ vậy nhân sự bán hàng chạy trên ĐÚNG khoá, ĐÚNG SDK, ĐÚNG cấu hình mà copilot đang
 * dùng — đổi `AI_PROVIDER` một lần là cả hai đổi theo.
 *
 * ─── HAI NẤC CỦA NHÂN SỰ ÁNH XẠ SANG BA BẬC CỦA ERP ───
 *
 *   ECONOMY → `routine` (mô hình rẻ, việc nhiều: hiểu ý khách, bóc thực thể)
 *   STRONG  → `copilot` (mô hình mạnh hơn, chỉ khi nấc rẻ không đủ tự tin)
 *
 * KHÔNG dùng bậc `analysis`: đó là bậc đắt nhất, dành cho phân tích cho chủ shop. Một tin nhắn
 * khách không đáng giá đó, và mở sẵn đường tới nó là mở sẵn đường để hoá đơn tăng mười lần vì một
 * dòng cấu hình gõ nhầm.
 */
import { makeAiProvider } from "@/lib/ai/provider";
import { EFFORT_BY_TIER, modelFor, resolveProviderName, type AiTier } from "@/lib/ai/router";
import type { RouteTier } from "@/lib/constants/ai";
import {
  ModelTimeoutError,
  ModelUnavailableError,
  type CompletionRequest,
  type CompletionResult,
  type ModelProvider,
} from "@/lib/ai-workforce/providers/types";

/**
 * Chỉ HAI nấc gọi mô hình được ánh xạ. `RULE` không gọi mô hình, `HUMAN` là chuyển người — cả hai
 * không bao giờ tới được đây, và khai chúng ở bảng này là mời một lỗi gõ nhầm biến "chuyển người"
 * thành một lượt gọi mô hình.
 */
const BAC_ERP: Record<"ECONOMY" | "STRONG", AiTier> = { ECONOMY: "routine", STRONG: "copilot" };

function bacCua(tier: RouteTier): AiTier | null {
  return tier === "ECONOMY" || tier === "STRONG" ? BAC_ERP[tier] : null;
}

/**
 * Lời dặn thêm khi cần JSON.
 *
 * Lớp ERP không có cờ "chế độ JSON" — và hợp đồng `CompletionRequest.json` đã nói rõ: nhà cung cấp
 * nào không ép được thì phải cố qua lời dặn. Đây là chỗ cố ấy. Phần BẢO ĐẢM nằm ở chỗ khác và
 * mạnh hơn: bộ định tuyến kiểm lược đồ bằng zod, sai thì leo nấc rồi chuyển người — nên một lượt
 * trả về chữ thừa không bao giờ đi tiếp vào trạng thái bán hàng.
 */
const DAN_JSON = "\n\nCHỈ trả về một đối tượng JSON hợp lệ, không rào đón, không khối mã, không giải thích.";

export class ErpSharedProvider implements ModelProvider {
  /** Tên này đi vào `ai_model_calls.provider`, nên nó phải nói được "chạy trên tầng nào". */
  readonly name = "erp";

  available() {
    return resolveProviderName() !== null;
  }

  defaultModel(tier: RouteTier) {
    const nha = resolveProviderName();
    const bac = bacCua(tier);
    return nha && bac ? modelFor(nha, bac) : "";
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const nha = resolveProviderName();
    if (!nha) throw new ModelUnavailableError("ERP chưa cấu hình AI (thiếu OPENAI_API_KEY hoặc ANTHROPIC_API_KEY)");
    if (!request.model) throw new ModelUnavailableError("Chưa có tên mô hình cho nấc này");

    /*
      MỨC SUY LUẬN đi theo NẤC, không theo cấu hình toàn cục của copilot.

      Nấc ECONOMY của nhân sự bán hàng là việc rẻ và nhiều — bắt nó suy luận ở mức `medium` vì
      `AI_EFFORT` đang đặt cho copilot là trả tiền cho thứ không dùng tới, trên mọi tin nhắn.
    */
    const effort = EFFORT_BY_TIER[request.model === this.defaultModel("STRONG") ? BAC_ERP.STRONG : BAC_ERP.ECONOMY];
    const provider = makeAiProvider(nha, request.model, effort, request.timeoutMs);

    let res;
    try {
      res = await provider.complete({
        system: request.system + (request.json ? DAN_JSON : ""),
        messages: request.messages.map((m) => ({ role: m.role, content: [{ type: "text" as const, text: m.content }] })),
        tools: [],
        maxTokens: request.maxOutputTokens,
      });
    } catch (error) {
      // SDK của cả hai nhà cung cấp ném lỗi hết giờ với tên riêng; quy chúng về MỘT loại để bộ
      // định tuyến xử lý giống nhau (leo nấc rồi chuyển người), không phải đoán tên lỗi của SDK.
      const msg = error instanceof Error ? error.message : String(error);
      if (error instanceof Error && /timeout|aborted|ETIMEDOUT/i.test(error.name + msg)) {
        throw new ModelTimeoutError(`${nha}: quá ${request.timeoutMs} ms không phản hồi`);
      }
      throw new ModelUnavailableError(`${nha}: ${msg}`);
    }

    // `refusal` KHÔNG được trả về như một câu trả lời rỗng: bộ định tuyến sẽ coi đó là lược đồ sai
    // rồi leo nấc, tốn thêm một lượt gọi cho một câu mô hình đã từ chối trả lời.
    if (res.stopReason === "refusal") throw new ModelUnavailableError(`${nha}: mô hình từ chối trả lời`);

    return {
      text: res.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim(),
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      cacheReadInputTokens: res.usage.cacheReadTokens,
      cacheWriteInputTokens: res.usage.cacheWriteTokens,
      // Tên mô hình THẬT mà API báo về, không phải tên đã yêu cầu — hai thứ có thể khác nhau khi
      // nhà cung cấp đổi bản, và bảng giá phải tra theo cái API báo.
      model: res.model || request.model,
      provider: `${this.name}:${nha}`,
    };
  }
}
