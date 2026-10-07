import { classifyAiFailure } from "@/lib/constants/ai-incidents";
import type { AiProvider } from "@/lib/ai/provider";

/**
 * ═══════════ MODEL CHÍNH → MODEL DỰ PHÒNG CỦA KHOÁ NỀN TẢNG (Platform AI Policy · docs/platform/ai-model-control.md) ═══════════
 *
 * Cùng MỘT khoá, hai model: nhánh canary đi `primary` (model mới), hỏng VÌ BẤT KỲ LÝ DO GÌ thì CÙNG lời gọi đó đi lại
 * bằng `fallback` (model đã chạy ổn) — trước khi có chữ nào tới khách, nên không bao giờ sinh hai câu trả lời. Cả hai
 * cùng hỏng ⇒ ném lỗi của `fallback` như một lượt hỏng bình thường (engine chuyển người như cũ).
 *
 * «Model không có cho khoá này» (404 · `MODEL_UNAVAILABLE`) không tự khỏi ⇒ bỏ qua `primary` 1 giờ trong tiến trình này,
 * khỏi tốn một lời gọi hỏng cho mỗi tin khách. Lỗi khác (429, 5xx, hết giờ) không đánh dấu: lượt sau thử lại `primary`.
 *
 * `model` là của nhánh VỪA PHỤC VỤ (đọc SAU lời gọi) — sổ AI ghi đúng model đã chạy; lượt hỏng của `primary` báo qua
 * `onPrimaryFailed` để bên gọi ghi MỘT dòng `ERROR` (token / tiền `NULL` = chưa biết, không phải 0).
 */
export const PLATFORM_PRIMARY_SKIP_MS = 3_600_000;

export type PlatformPrimaryFailure = { name: string; model: string; fallbackModel: string; error: string; modelUnavailable: boolean };

const holder = globalThis as typeof globalThis & { __erpPlatformPrimarySkip?: Map<string, number> };
const skipMap = () => (holder.__erpPlatformPrimarySkip ??= new Map<string, number>());

/** Chỉ bài kiểm: xoá dấu "model chính đang bị bỏ qua". */
export function resetPlatformPrimarySkipForTests() {
  skipMap().clear();
}

export function withPlatformFallback(primary: AiProvider, fallback: AiProvider, onPrimaryFailed?: (f: PlatformPrimaryFailure) => void, nowMs: () => number = Date.now): AiProvider {
  const key = `${primary.name}:${primary.model}`;
  let served: AiProvider = primary;
  return {
    name: primary.name,
    schemaDialect: primary.schemaDialect,
    get model() {
      return served.model;
    },
    async complete(req) {
      const badAt = skipMap().get(key);
      if (badAt !== undefined && nowMs() - badAt < PLATFORM_PRIMARY_SKIP_MS) {
        served = fallback;
        return fallback.complete(req);
      }
      try {
        const res = await primary.complete(req);
        served = primary;
        return res;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const modelUnavailable = classifyAiFailure(message) === "MODEL_UNAVAILABLE";
        if (modelUnavailable) skipMap().set(key, nowMs());
        try {
          onPrimaryFailed?.({ name: primary.name, model: primary.model, fallbackModel: fallback.model, error: message.slice(0, 300), modelUnavailable });
        } catch {
          // Ghi sổ hỏng không được làm hỏng lượt trả lời khách.
        }
        served = fallback;
        return fallback.complete(req);
      }
    },
  };
}
