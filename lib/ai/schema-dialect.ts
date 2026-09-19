/**
 * ═══════════ MỘT HỢP ĐỒNG TOOL, NHIỀU PHƯƠNG NGỮ SCHEMA ═══════════
 *
 * ĐÃ ĐO THẬT trên production 19/09/2026, provider `anthropic`, một lượt AI Copilot có tool:
 *
 *     400 invalid_request_error
 *     tools.2.custom: For 'integer' type, properties maximum, minimum are not supported
 *
 * `tools.2` là `search_care_cases` — tool đầu tiên trong danh sách có một ô số nguyên mang
 * `minimum`/`maximum` (`limit: z.number().int().min(1).max(50)`). AI CTO không dính vì nó gọi model
 * với `tools: []`.
 *
 * Nguyên nhân gốc KHÔNG phải một tool viết sai. `toProviderTools()` dựng ĐÚNG MỘT JSON Schema thô
 * rồi đưa nguyên xi cho cả hai adapter, trong khi chế độ `strict` của Anthropic nhận một TẬP CON
 * hẹp hơn của JSON Schema so với `strict` của OpenAI. Một hình dạng, hai nơi nhận, hai luật khác
 * nhau — nên nơi nào hẹp hơn thì vỡ.
 *
 * Luật thay thế: hợp đồng tool ở cấp nghiệp vụ vẫn là MỘT (zod trong `lib/ai/tools/*`), còn việc
 * SERIALIZE thì mỗi provider tự làm theo phương ngữ của mình.
 *
 * ═══════════ MODEL KHÔNG PHẢI NƠI XÁC MINH ═══════════
 *
 * Bỏ `minimum`/`maximum` khỏi schema GỬI CHO MODEL không hề nới lỏng luật: ràng buộc thật vẫn nằm
 * ở zod và vẫn chạy ở MÁY CHỦ trước khi tool được gọi — `runCopilot` và `confirmCopilotActions`
 * đều `tool.input.safeParse()` rồi mới `tool.run()`. Schema của model là GỢI Ý để nó gõ đúng ngay
 * lần đầu; `tool.input` là CỔNG. Đảo hai vai đó (tin model đã kiểm hộ) là để một chuỗi trong câu
 * hỏi của người dùng quyết định `limit` của một truy vấn.
 *
 * Nên ràng buộc bị gỡ khỏi schema được VIẾT LẠI THÀNH CHỮ trong `description`: model vẫn biết
 * "tối đa 50", chỉ là nó biết bằng câu chữ thay vì bằng một khoá schema mà API từ chối. Gỡ mà
 * không nói lại là bắt model đoán, rồi trả về một lỗi zod mà nó phải thử lại mới sửa được.
 */

export type AiSchemaDialect = "anthropic" | "openai";

/**
 * Từ khoá JSON Schema mà chế độ `strict` của Anthropic KHÔNG nhận (tài liệu structured outputs:
 * ràng buộc số, ràng buộc độ dài chuỗi, ràng buộc mảng phức tạp).
 *
 * `pattern` không nằm trong danh sách ĐƯỢC HỖ TRỢ của tài liệu (chỉ `format` của chuỗi được nêu),
 * nên nó nằm đây theo hướng HẸP HƠN: gỡ một khoá mà API có thể vẫn nhận thì mất một chút gợi ý,
 * còn giữ một khoá mà API từ chối thì MẤT TRỌN lượt gọi. Cũng chính vì thế `minLength`/`maxLength`
 * nằm đây dù lỗi production chỉ mới nêu tên `integer`: API dừng ở lỗi ĐẦU TIÊN nó gặp, nên "chưa
 * bị nêu tên" không phải "đã được chấp nhận".
 */
export const ANTHROPIC_UNSUPPORTED_KEYWORDS = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
] as const;

export type UnsupportedKeyword = (typeof ANTHROPIC_UNSUPPORTED_KEYWORDS)[number];

/** Ràng buộc bị gỡ được nói lại bằng tiếng Việt, để model vẫn gõ đúng ngay lần đầu. */
const HINT: Record<UnsupportedKeyword, (value: unknown) => string | null> = {
  minimum: (v) => `tối thiểu ${num(v)}`,
  maximum: (v) => `tối đa ${num(v)}`,
  exclusiveMinimum: (v) => `lớn hơn ${num(v)}`,
  exclusiveMaximum: (v) => `nhỏ hơn ${num(v)}`,
  multipleOf: (v) => `bội số của ${num(v)}`,
  minLength: (v) => `ít nhất ${num(v)} ký tự`,
  maxLength: (v) => `nhiều nhất ${num(v)} ký tự`,
  pattern: () => "đúng mẫu đã mô tả",
  minItems: (v) => `ít nhất ${num(v)} phần tử`,
  maxItems: (v) => `nhiều nhất ${num(v)} phần tử`,
  // `uniqueItems: false` không ràng buộc gì nên không cần nói lại.
  uniqueItems: (v) => (v === true ? "các phần tử không trùng nhau" : null),
};

function num(v: unknown): string {
  return typeof v === "number" || typeof v === "string" ? String(v) : JSON.stringify(v);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Gỡ các khoá không được hỗ trợ khỏi MỘT nút, đệ quy xuống mọi nút con (`properties`, `items`,
 * `anyOf`, `allOf`, `$defs`…). Thứ tự khoá được GIỮ NGUYÊN và phần chữ thêm vào là hàm thuần của
 * đầu vào ⇒ cùng một tool luôn ra cùng một chuỗi JSON, nên đệm prompt của provider không bị vỡ.
 */
function stripNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripNode);
  if (!isPlainObject(node)) return node;

  const out: Record<string, unknown> = {};
  const hints: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    if ((ANTHROPIC_UNSUPPORTED_KEYWORDS as readonly string[]).includes(key)) {
      const hint = HINT[key as UnsupportedKeyword](value);
      if (hint) hints.push(hint);
      continue;
    }
    out[key] = stripNode(value);
  }
  if (hints.length) {
    const note = `Ràng buộc: ${hints.join(", ")} (máy chủ kiểm lại, sai thì lượt gọi bị từ chối).`;
    const current = typeof out.description === "string" ? out.description.trim() : "";
    out.description = current ? `${current} ${note}` : note;
  }
  return out;
}

/**
 * Serialize một JSON Schema hợp đồng sang phương ngữ của một provider.
 *
 * · `anthropic` — gỡ các khoá `strict` không nhận, viết lại thành chữ trong `description`.
 * · `openai`    — GIỮ NGUYÊN. Responses API nhận các ràng buộc này, và đổi nó ở đây là sửa một
 *                 đường đang chạy được để chữa một đường khác. Một phương ngữ hỏng thì chỉ một
 *                 phương ngữ phải đổi.
 */
export function toDialectSchema(schema: Record<string, unknown>, dialect: AiSchemaDialect): Record<string, unknown> {
  if (dialect !== "anthropic") return structuredClone(schema);
  return stripNode(schema) as Record<string, unknown>;
}

/** Khoá không được hỗ trợ còn sót lại trong một schema — dùng cho kiểm thử và chẩn đoán. */
export function findUnsupportedKeywords(schema: unknown, path = ""): string[] {
  if (Array.isArray(schema)) return schema.flatMap((v, i) => findUnsupportedKeywords(v, `${path}[${i}]`));
  if (!isPlainObject(schema)) return [];
  const found: string[] = [];
  for (const [key, value] of Object.entries(schema)) {
    if ((ANTHROPIC_UNSUPPORTED_KEYWORDS as readonly string[]).includes(key)) found.push(`${path}.${key}`);
    found.push(...findUnsupportedKeywords(value, `${path}.${key}`));
  }
  return found;
}
