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
 * ═══════════ TỪ KHOÁ CHỈ LÀ TỪ KHOÁ Ở VỊ TRÍ TỪ KHOÁ ═══════════
 *
 * ĐO THẬT 29/09/2026 (E2E #6, AI Builder, khoá Anthropic của tổ chức thử):
 *
 *     400 invalid_request_error — tools.0.custom.input_schema: JSON schema is invalid.
 *     It must match JSON Schema draft 2020-12
 *
 * Bản cũ gỡ `minLength` / `pattern`… ở MỌI tầng, kể cả BÊN TRONG map `properties` — nơi chúng là TÊN FIELD
 * (blueprint có field `validation.pattern`, `validation.minLength`). Tệ hơn, nó coi chính map `properties` là
 * một nút schema và chèn `description: "Ràng buộc: …"` vào đó ⇒ một "field" tên `description` có giá trị là
 * CHUỖI thay vì schema ⇒ cả schema sai chuẩn. Copilot không dính vì chưa tool nào có field trùng tên từ khoá.
 *
 * Luật: đi theo CẤU TRÚC của JSON Schema. Nút schema ⇒ gỡ từ khoá không hỗ trợ; giá trị của `properties` /
 * `patternProperties` / `$defs` / `definitions` / `dependentSchemas` là MAP tên → schema (tên giữ nguyên, chỉ
 * đệ quy vào schema con); `items` / `anyOf` / … là schema con; `enum` / `const` / `required` / `default` /
 * `examples` / chữ mô tả là DỮ LIỆU — chép nguyên, không bao giờ gỡ gì bên trong.
 */
const SCHEMA_MAP_KEYWORDS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
const SCHEMA_VALUE_KEYWORDS = new Set(["items", "additionalItems", "additionalProperties", "propertyNames", "contains", "not", "if", "then", "else", "unevaluatedItems", "unevaluatedProperties"]);
const SCHEMA_LIST_KEYWORDS = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);

function mapSchemaMap(value: unknown, fn: (schema: unknown) => unknown): unknown {
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([name, schema]) => [name, fn(schema)]));
}

/**
 * Gỡ các khoá không được hỗ trợ khỏi MỘT nút SCHEMA, đệ quy xuống đúng các vị trí schema con. Thứ tự khoá được
 * GIỮ NGUYÊN và phần chữ thêm vào là hàm thuần của đầu vào ⇒ cùng một tool luôn ra cùng một chuỗi JSON, nên đệm
 * prompt của provider không bị vỡ.
 */
function stripNode(node: unknown): unknown {
  if (!isPlainObject(node)) return node; // schema boolean (`true` / `false`) hoặc giá trị lạ: giữ nguyên

  const out: Record<string, unknown> = {};
  const hints: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    if ((ANTHROPIC_UNSUPPORTED_KEYWORDS as readonly string[]).includes(key)) {
      const hint = HINT[key as UnsupportedKeyword](value);
      if (hint) hints.push(hint);
      continue;
    }
    if (SCHEMA_MAP_KEYWORDS.has(key)) out[key] = mapSchemaMap(value, stripNode);
    else if (SCHEMA_VALUE_KEYWORDS.has(key)) out[key] = Array.isArray(value) ? value.map(stripNode) : stripNode(value);
    else if (SCHEMA_LIST_KEYWORDS.has(key)) out[key] = Array.isArray(value) ? value.map(stripNode) : value;
    else out[key] = structuredClone(value);
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

/**
 * Khoá không được hỗ trợ còn sót lại ở VỊ TRÍ TỪ KHOÁ của một schema — dùng cho kiểm thử và chẩn đoán. Tên field
 * trùng tên từ khoá (field `pattern` trong `properties`) KHÔNG phải từ khoá và không bị tính.
 */
export function findUnsupportedKeywords(schema: unknown, path = ""): string[] {
  if (!isPlainObject(schema)) return [];
  const found: string[] = [];
  for (const [key, value] of Object.entries(schema)) {
    const here = `${path}.${key}`;
    if ((ANTHROPIC_UNSUPPORTED_KEYWORDS as readonly string[]).includes(key)) found.push(here);
    else if (SCHEMA_MAP_KEYWORDS.has(key) && isPlainObject(value)) for (const [name, sub] of Object.entries(value)) found.push(...findUnsupportedKeywords(sub, `${here}.${name}`));
    else if (SCHEMA_VALUE_KEYWORDS.has(key)) found.push(...(Array.isArray(value) ? value.flatMap((v, i) => findUnsupportedKeywords(v, `${here}[${i}]`)) : findUnsupportedKeywords(value, here)));
    else if (SCHEMA_LIST_KEYWORDS.has(key) && Array.isArray(value)) found.push(...value.flatMap((v, i) => findUnsupportedKeywords(v, `${here}[${i}]`)));
  }
  return found;
}

/**
 * Kiểm HÌNH của một nút schema sau khi serialize: mọi giá trị trong map `properties` (và các map tương tự) phải là
 * schema (object hoặc boolean). Bắt đúng lớp lỗi 29/09/2026 (chuỗi `description` lọt vào `properties`) trước khi
 * nhà cung cấp trả 400 — dùng trong kiểm thử.
 */
export function schemaShapeProblems(schema: unknown, path = ""): string[] {
  if (typeof schema === "boolean") return [];
  if (!isPlainObject(schema)) return [`${path || "$"}: nút schema phải là object hoặc boolean`];
  const found: string[] = [];
  for (const [key, value] of Object.entries(schema)) {
    const here = `${path}.${key}`;
    if (SCHEMA_MAP_KEYWORDS.has(key)) {
      if (!isPlainObject(value)) found.push(`${here}: phải là map tên → schema`);
      else for (const [name, sub] of Object.entries(value)) found.push(...schemaShapeProblems(sub, `${here}.${name}`));
    } else if (SCHEMA_VALUE_KEYWORDS.has(key)) {
      found.push(...(Array.isArray(value) ? value.flatMap((v, i) => schemaShapeProblems(v, `${here}[${i}]`)) : schemaShapeProblems(value, here)));
    } else if (SCHEMA_LIST_KEYWORDS.has(key)) {
      if (!Array.isArray(value) || value.length === 0) found.push(`${here}: phải là mảng schema khác rỗng`);
      else found.push(...value.flatMap((v, i) => schemaShapeProblems(v, `${here}[${i}]`)));
    }
  }
  return found;
}
