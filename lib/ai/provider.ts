import Anthropic, { type ClientOptions } from "@anthropic-ai/sdk";
import { EFFORT_BY_TIER, modelFor, resolveProviderName, type AiTier } from "@/lib/ai/router";
import { toDialectSchema, type AiSchemaDialect } from "@/lib/ai/schema-dialect";
import { OpenAiProvider } from "@/lib/ai/providers/openai";
import { env } from "@/lib/env";

/**
 * ═══════════ LỚP PROVIDER — AI LAYER KHÔNG KHOÁ VÀO MỘT MODEL ═══════════
 *
 * Copilot chỉ nói chuyện với `AiProvider` bằng các hình dạng tối giản dưới đây (text · tool_use ·
 * tool_result). Bản Anthropic ánh xạ sang SDK chính thức; bản Fake dùng cho kiểm thử và benchmark.
 * Thêm provider khác = thêm một file, không đụng copilot.
 */

export type AiToolDef = { name: string; description: string; inputSchema: Record<string, unknown> };

export type AiBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean };

export type AiMessage = { role: "user" | "assistant"; content: AiBlock[] };

export type AiUsage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };

export type AiRequest = { system: string; messages: AiMessage[]; tools: AiToolDef[]; maxTokens?: number };

export type AiResponse = { content: AiBlock[]; stopReason: "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other"; usage: AiUsage; model: string; latencyMs: number };

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  /**
   * Phương ngữ JSON Schema mà provider này nhận. KHAI RA chứ không giấu trong thân `complete()`:
   * hợp đồng tool ở cấp nghiệp vụ chỉ có một, nên chỗ duy nhất hai provider được phép khác nhau
   * là bước serialize — và bài kiểm phải đọc được nó để chứng minh từng đường đi đúng luật của
   * mình (`lib/ai/schema-dialect.ts`).
   */
  readonly schemaDialect: AiSchemaDialect;
  complete(req: AiRequest): Promise<AiResponse>;
}

/**
 * Giá USD / 1M token — bảng trong mã để ước tính chi phí; không phải hoá đơn. Model không có trong
 * bảng ⇒ chi phí CHƯA BIẾT (`null`), không phải 0 — cập nhật bảng khi có giá niêm yết.
 */
const PRICE_PER_MTOK: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

/**
 * ═══════════ TÊN MODEL TRONG PHONG BÌ TRẢ VỀ KHÔNG PHẢI TÊN TRONG BẢNG GIÁ ═══════════
 *
 * ĐÃ CẮN THẬT — lượt chạy agent #16. Kho gọi bí danh `claude-haiku-4-5`, nhưng Anthropic trả về
 * `claude-haiku-4-5-20251001` (bí danh + ngày phát hành). Tra thẳng chuỗi ấy trong bảng giá không
 * thấy gì, nên cả lượt chạy in ra **"tiền: CHƯA ĐO ĐƯỢC"** — đúng luật (mục 42: không định giá
 * được thì không được bịa ra 0), nhưng vô dụng: phép đo sinh ra để trả lời câu "tốn bao nhiêu" lại
 * không trả lời được câu nào.
 *
 * Nên tra theo TIỀN TỐ DÀI NHẤT khớp. Chọn dài nhất chứ không phải khớp đầu tiên: nếu một ngày có
 * cả `claude-opus-5` lẫn `claude-opus-5-mini` trong bảng, khớp đầu tiên sẽ tính giá model to cho
 * model nhỏ — sai theo hướng đắt lên, và không ai kiểm lại một con số đã có vẻ hợp lý.
 *
 * Không khớp tiền tố nào thì VẪN trả `null`. Đoán giá của một model chưa khai còn tệ hơn nói
 * "chưa biết".
 */
export function khoaGiaKhop(model: string, khoa: readonly string[]): string | null {
  if (khoa.includes(model)) return model;
  /*
    KHỚP DÀI NHẤT. Bảng giá hôm nay không có khoá nào là tiền tố của khoá khác, nên tính chất này
    chưa đổi được kết quả nào — nó là hàng rào cho ngày bảng giá có thêm một biến thể. Tách thành
    hàm thuần nhận danh sách khoá chính là để bài kiểm dựng được tình huống ấy mà không phải đợi
    tới ngày nó xảy ra thật.
  */
  const hop = khoa.filter((k) => model.startsWith(k)).sort((a, b) => b.length - a.length);
  return hop.length ? hop[0] : null;
}

export function giaCuaModel(model: string): { input: number; output: number; cacheRead: number; cacheWrite: number } | null {
  const k = khoaGiaKhop(model, Object.keys(PRICE_PER_MTOK));
  return k ? PRICE_PER_MTOK[k] : null;
}

export function estimateCostUsd(model: string, usage: AiUsage): number | null {
  const p = giaCuaModel(model);
  if (!p) return null;
  const usd = (usage.inputTokens * p.input + usage.outputTokens * p.output + usage.cacheReadTokens * p.cacheRead + usage.cacheWriteTokens * p.cacheWrite) / 1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}

/**
 * ═══════════ KHÔNG PHẢI MODEL NÀO CŨNG NHẬN CÙNG MỘT BỘ THAM SỐ ═══════════
 *
 * ĐÃ ĐO THẬT (lượt chạy agent thứ ba, 19/09/2026) — khoá đúng, tài khoản có tiền, và vẫn 400:
 *
 *     400 invalid_request_error: "adaptive thinking is not supported on this model"
 *
 * Bậc `routine` của Anthropic là `claude-haiku-4-5`, và model đó KHÔNG nhận
 * `thinking: {type: "adaptive"}` (nó thuộc thế hệ dùng `budget_tokens`) lẫn `output_config.effort`.
 * Bản cũ gửi cả hai cho MỌI model, nên mọi lượt gọi bậc `routine` qua Anthropic đều hỏng — kể cả
 * `testAiConnection()`, tức là đúng cái cửa mà máy runner dùng để hỏi "khoá dùng được chưa".
 *
 * Hai tham số ấy là TUỲ CHỌN về mặt nghiệp vụ: thiếu chúng thì câu trả lời kém sâu hơn, còn gửi
 * nhầm thì KHÔNG có câu trả lời nào. Nên chúng đi theo BẢNG NĂNG LỰC của từng model.
 *
 * Model lạ (chưa có trong bảng) được coi là THẾ HỆ MỚI: sai ở hướng đó là một lỗi 400 ồn ào mà
 * `npm run agent:check` bắt được ngay, còn sai ở hướng kia là lặng lẽ mất chiều sâu suy luận mà
 * không ai biết. Thêm model mới thì thêm một dòng ở đây.
 */
type AnthropicCaps = { adaptiveThinking: boolean; effort: boolean; fallbacks: boolean };

const ANTHROPIC_CAPS: Record<string, AnthropicCaps> = {
  // Thế hệ `budget_tokens`: KHÔNG adaptive, KHÔNG effort. Bậc `routine` của ERP nằm ở đây.
  "claude-haiku-4-5": { adaptiveThinking: false, effort: false, fallbacks: false },
  // Thế hệ hiện tại. `fallbacks` (chạy lại trên model dự phòng khi bị từ chối vì chính sách) chỉ
  // khai cho các model tài liệu nói rõ là có.
  "claude-opus-5": { adaptiveThinking: true, effort: true, fallbacks: true },
  "claude-sonnet-5": { adaptiveThinking: true, effort: true, fallbacks: false },
};

/** Model đã được KHAI. Bài kiểm đối chiếu với `MODEL_BY_TIER` để không bậc nào rơi vào nhánh đoán. */
export const ANTHROPIC_DECLARED_MODELS: readonly string[] = Object.keys(ANTHROPIC_CAPS);

export function anthropicCapsOf(model: string): AnthropicCaps {
  return ANTHROPIC_CAPS[model] ?? { adaptiveThinking: true, effort: true, fallbacks: false };
}

/**
 * Trần token mà một lượt KHÔNG streaming còn an toàn.
 *
 * SDK Anthropic tính `expectedTime = 60 phút × max_tokens / 128000` rồi TỪ CHỐI lượt không
 * streaming khi nó vượt mặc định 10 phút. Phép kiểm đó chỉ chạy khi lời gọi KHÔNG truyền `timeout`
 * — mà ta có truyền (xem `TIMEOUT_BY_TIER`), nên SDK bỏ qua nó và ta thừa hưởng nguyên cái vách đá
 * nó dựng lên để tránh: lượt gọi hết giờ giữa chừng, không có lấy một dòng chữ để đọc.
 *
 * Nên ta tự giữ CÙNG MỘT ngưỡng, tính lại từ chính hai con số của SDK thay vì chép một số:
 * xin nhiều hơn thế thì streaming, và lượt gọi không còn phụ thuộc vào việc model trả lời nhanh
 * tới đâu.
 */
export const NGUONG_KHONG_STREAM = Math.floor((128_000 * 10) / 60);

export class AnthropicProvider implements AiProvider {
  readonly name = "anthropic";
  readonly model: string;
  readonly schemaDialect: AiSchemaDialect = "anthropic";
  private client: Anthropic;
  // `fetchImpl` đứng CUỐI để không đổi thứ tự tham số các nơi gọi cũ đang dùng; chỉ kiểm thử truyền.
  constructor(
    model: string,
    private effort: "low" | "medium" | "high" = "medium",
    timeoutMs: number = TIMEOUT_BY_TIER.copilot,
    soLanThuLai: number = RETRIES_BY_TIER.copilot,
    fetchImpl?: typeof fetch,
  ) {
    this.model = model;
    // Khoá đọc từ môi trường bởi SDK (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN) — không truyền tay, không log.
    this.client = new Anthropic({ maxRetries: soLanThuLai, timeout: timeoutMs, ...(fetchImpl ? { fetch: fetchImpl as ClientOptions["fetch"] } : {}) });
  }

  async complete(req: AiRequest): Promise<AiResponse> {
    const started = Date.now();
    const caps = anthropicCapsOf(this.model);
    const body = {
      model: this.model,
      max_tokens: req.maxTokens ?? 4000,
      // Prompt hệ thống ổn định ⇒ đệm được; phần bối cảnh thay đổi nằm trong messages.
      system: [{ type: "text" as const, text: req.system, cache_control: { type: "ephemeral" as const } }],
      ...(caps.adaptiveThinking ? { thinking: { type: "adaptive" as const } } : {}),
      ...(caps.effort ? { output_config: { effort: this.effort } } : {}),
      // Từ chối vì chính sách ⇒ máy chủ tự chạy lại trên model dự phòng trong cùng một lần gọi.
      ...(caps.fallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      // Hợp đồng tool là MỘT; chỉ bước serialize đi theo phương ngữ của provider — xem
      // `lib/ai/schema-dialect.ts`. Ràng buộc bị gỡ ở đây vẫn được zod kiểm ở máy chủ trước khi
      // tool chạy (`runCopilot` / `confirmCopilotActions`), nên không luật nghiệp vụ nào bị nới.
      tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: toDialectSchema(t.inputSchema, this.schemaDialect) as Anthropic.Beta.BetaTool["input_schema"], strict: true })),
      /*
        ═══════════ ĐỆM CẢ PHẦN ĐẦU CỦA CUỘC HỘI THOẠI, KHÔNG CHỈ PROMPT HỆ THỐNG ═══════════

        Một vòng lặp agent gửi lại TOÀN BỘ lịch sử ở mỗi vòng. Tới vòng thứ n, phần đầu giống hệt
        n−1 lần trước — nhưng nếu không đánh dấu đệm thì lần nào cũng trả tiền đầu vào đầy đủ.

        Đo trên bảng giá đang khai: `claude-opus-5` là **$5/M** đầu vào nhưng **$0,5/M** khi đọc từ
        đệm — mười lần. Với 24 vòng, phần lịch sử lặp lại chính là khoản tiền lớn nhất của cả lượt
        chạy, và nó là khoản dễ cắt nhất vì nội dung KHÔNG đổi.

        Cách làm: đánh dấu `cache_control` lên khối CUỐI CÙNG của tin nhắn CUỐI CÙNG. Anthropic đệm
        toàn bộ tiền tố tính tới điểm ấy, nên vòng sau đọc lại gần như cả cuộc hội thoại từ đệm.
        Chỉ một điểm đánh dấu — nhiều điểm không đệm được nhiều hơn, chỉ tốn thêm chỗ.

        KHÔNG đổi một chữ nào của nội dung gửi đi: đệm là chuyện hoá đơn, không phải chuyện ngữ nghĩa.
      */
      messages: req.messages.map((m, iTin) => ({
        role: m.role,
        content: m.content.map((b, iKhoi) => {
          const cuoiCung = iTin === req.messages.length - 1 && iKhoi === m.content.length - 1;
          const dem = cuoiCung ? { cache_control: { type: "ephemeral" as const } } : {};
          return b.type === "text"
            ? ({ type: "text", text: b.text, ...dem } as const)
            : b.type === "tool_use"
              ? ({ type: "tool_use", id: b.id, name: b.name, input: b.input, ...dem } as const)
              : ({ type: "tool_result", tool_use_id: b.toolUseId, content: b.content, is_error: b.isError ?? false, ...dem } as const);
        }),
      })),
    };
    // Lượt dài đi bằng streaming — xem `NGUONG_KHONG_STREAM`. Phong bì trả về giống hệt nhau, nên
    // phần đọc kết quả bên dưới không cần biết mình vừa đi đường nào.
    const res =
      body.max_tokens > NGUONG_KHONG_STREAM
        ? await this.client.beta.messages.stream(body).finalMessage()
        : await this.client.beta.messages.create(body);
    const content: AiBlock[] = [];
    for (const block of res.content) {
      if (block.type === "text") content.push({ type: "text", text: block.text });
      else if (block.type === "tool_use") content.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
    }
    const stop = res.stop_reason;
    return {
      content,
      stopReason: stop === "end_turn" || stop === "tool_use" || stop === "max_tokens" || stop === "refusal" ? stop : "other",
      usage: {
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
        cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
      },
      model: res.model,
      latencyMs: Date.now() - started,
    };
  }
}

/**
 * Provider giả cho kiểm thử / benchmark: trả lời theo kịch bản, đếm được số lần gọi, đo được chi
 * phí vòng lặp của chính copilot (không tính mạng).
 */
export class FakeProvider implements AiProvider {
  readonly name = "fake";
  readonly model = "fake-model";
  // Provider giả không serialize gì; khai phương ngữ của production để không ai đọc nhầm nó là
  // một đường đi thứ ba.
  readonly schemaDialect: AiSchemaDialect = "anthropic";
  calls: AiRequest[] = [];
  constructor(private script: ((req: AiRequest, round: number) => AiResponse | Omit<AiResponse, "usage" | "model" | "latencyMs">)[] = []) {}
  async complete(req: AiRequest): Promise<AiResponse> {
    const round = this.calls.length;
    this.calls.push(req);
    const step = this.script[round] ?? this.script[this.script.length - 1];
    const out = step ? step(req, round) : { content: [{ type: "text" as const, text: "(fake) không có kịch bản" }], stopReason: "end_turn" as const };
    return { usage: { inputTokens: 1200, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: this.model, latencyMs: 0, ...out };
  }
}

const cached = new Map<AiTier, AiProvider>();
let override: AiProvider | null | undefined;

/** Provider cho một bậc việc — chọn theo `lib/ai/router.ts`. `null` = AI chưa cấu hình. */
/**
 * ═══════════ HẾT GIỜ CHỜ ĐI THEO BẬC, KHÔNG PHẢI MỘT CON SỐ CHO TẤT CẢ ═══════════
 *
 * ĐÃ ĐO THẬT (lượt AI CTO lập kế hoạch đầu tiên, 19/09/2026): khoá đúng, tài khoản có tiền, và
 * lượt chạy chết với
 *
 *     Gọi model hỏng: Request timed out.
 *
 * Bậc `analysis` chạy Opus 5 với suy luận thích ứng ở mức `high` trên một bài lập kế hoạch — vài
 * phút là BÌNH THƯỜNG, không phải hỏng. Nhưng cả ba bậc đang dùng chung một hạn 60 giây ghim
 * cứng, con số hợp lý cho một lượt trò chuyện có người đang ngồi chờ và vô lý cho một lượt suy
 * nghĩ sâu chạy nền.
 *
 * Ba bậc, ba kỳ vọng khác nhau:
 *   · `routine`  — một lượt ping rẻ. Chậm quá 60 giây nghĩa là có gì đó hỏng thật.
 *   · `copilot`  — có NGƯỜI đang nhìn con trỏ nhấp nháy. Chờ quá hai phút thì thà báo lỗi.
 *   · `analysis` — chạy nền, không ai ngồi đợi. Lấy đúng mặc định 10 phút của SDK.
 *
 * Hạn quá ngắn KHÔNG rẻ hơn: SDK thử lại tối đa hai lần, nên mỗi lần hết giờ là tiền đã tiêu cho
 * phần model đã nghĩ, rồi vứt đi và nghĩ lại từ đầu.
 */
/**
 * ═══════════ SỐ LẦN THỬ LẠI CŨNG ĐI THEO BẬC ═══════════
 *
 * ĐÃ ĐO THẬT (hai lượt AI CTO liên tiếp, 19/09/2026 — 35429768726 và 35429814259): cả hai chết
 * trong 2 và 5 GIÂY với
 *
 *     {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}
 *
 * Đó là nhà cung cấp hết chỗ trong chốc lát, không phải lỗi của ta và không phải lỗi cấu hình.
 * Nhưng mặc định 2 lần thử với giãn cách nửa giây thì tiêu hết trước khi cơn quá tải kịp qua, và
 * cái giá là TRỌN MỘT lượt CI cộng một người phải vào bấm chạy lại.
 *
 * Kiên nhẫn đáng bao nhiêu thì tuỳ ai đang chờ:
 *   · `routine`/`copilot` — có NGƯỜI ngồi trước màn hình. Hết chỗ thì nói ngay, đừng bắt họ đợi.
 *   · `analysis`          — chạy nền, không ai đợi. Giãn cách luỹ thừa của SDK (0,5s → trần 8s)
 *                           qua 8 lần là khoảng 40 giây chịu đựng. Quá tải lâu hơn thế là sự cố
 *                           thật của nhà cung cấp, và lúc đó BÁO RA mới đúng, không phải giấu đi.
 */
export const RETRIES_BY_TIER: Record<AiTier, number> = {
  routine: 2,
  copilot: 2,
  analysis: 8,
};

export const TIMEOUT_BY_TIER: Record<AiTier, number> = {
  routine: 60_000,
  copilot: 120_000,
  analysis: 600_000,
};

export function getAiProvider(tier: AiTier = "copilot"): AiProvider | null {
  if (override !== undefined) return override;
  const hit = cached.get(tier);
  if (hit) return hit;
  const name = resolveProviderName();
  if (!name) return null;
  const effort = (env.ai.effort as "low" | "medium" | "high") || EFFORT_BY_TIER[tier];
  const model = modelFor(name, tier);
  const hanCho = TIMEOUT_BY_TIER[tier];
  const p: AiProvider = name === "openai" ? new OpenAiProvider(model, effort, undefined, hanCho) : new AnthropicProvider(model, effort, hanCho, RETRIES_BY_TIER[tier]);
  cached.set(tier, p);
  return p;
}
/** Chỉ cho kiểm thử: ép một provider (hoặc `null` = tắt); `undefined` = bỏ ép. */
export function setAiProviderForTests(p: AiProvider | null | undefined) {
  override = p;
  cached.clear();
}

/**
 * Thử kết nối AI cho trang Kết nối dữ liệu: một lượt gọi rẻ (bậc routine, không tool). Không trả
 * khoá; lỗi được provider SDK diễn giải (401 = khoá sai, 429 = hết hạn mức…).
 */
export async function testAiConnection(): Promise<{ provider: string; model: string; latencyMs: number; answer: string }> {
  const p = getAiProvider("routine");
  if (!p) throw new Error("AI chưa được cấu hình (thiếu OPENAI_API_KEY hoặc ANTHROPIC_API_KEY)");
  const res = await p.complete({ system: "Trả lời đúng một từ: OK", messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }], tools: [], maxTokens: 16 });
  const answer = res.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim().slice(0, 40);
  return { provider: p.name, model: res.model || p.model, latencyMs: res.latencyMs, answer };
}
