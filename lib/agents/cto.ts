/**
 * ═══════════ AI CTO — CHỈ LẬP KẾ HOẠCH, KHÔNG LÀM ═══════════
 *
 * Đọc một MỤC TIÊU trong hàng đợi Tech rồi đề nghị cách chia nó ra. Nó KHÔNG tạo việc, KHÔNG
 * giao ai, KHÔNG đổi ưu tiên, KHÔNG bật agent, KHÔNG duyệt, KHÔNG merge, KHÔNG deploy. Toàn bộ
 * đầu ra của nó là một dòng `tech_proposals` mà một con người phải bấm duyệt mới thành việc.
 *
 * ─── NGỮ CẢNH CÓ KIỂM SOÁT, KHÔNG PHẢI CẢ KHO ───
 *
 * Ném cả kho mã vào prompt là ba điều sai cùng lúc: tốn tiền theo cấp số, làm loãng đúng phần
 * quan trọng, và đưa vào những thứ không được phép rời máy chủ. Nên ngữ cảnh được CHỌN:
 *
 *   · luật bất di bất dịch — `AGENTS.md` mục 0 (bốn điều tối thiểu về đơn hàng/tiền/tồn kho)
 *   · mục tiêu gốc, và các việc Tech đang mở trong CÙNG module
 *   · sự cố đang mở, lượt deploy gần nhất
 *   · danh sách vai agent CÓ THẬT kèm quyền của từng vai
 *   · cây thư mục ở mức MÔ-ĐUN, không phải từng tệp
 *
 * KHÔNG bao giờ đi vào prompt: `.env`, khoá API, dữ liệu khách, số lương, PII. Danh sách chặn là
 * `CAM_TUYET_DOI` bên dưới, và nó được kiểm lại MỘT LẦN NỮA ngay trước khi gọi model — một hàng
 * rào chỉ đứng ở chỗ dựng prompt sẽ không thấy thứ lọt vào qua một đường khác.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { CTO_AGENT_KEYS, CTO_MAX_OUTPUT_TOKENS, CTO_MAX_TASKS, parseCtoPlan, type CtoPlan } from "@/lib/constants/cto-proposal";
import { TECH_AGENT_TEMPLATES, TECH_MODULES, TECH_TASK_TYPES } from "@/lib/constants/tech";
import type { AiProvider } from "@/lib/ai/provider";

/**
 * Những chuỗi KHÔNG BAO GIỜ được nằm trong prompt.
 *
 * Đây là lưới an toàn cuối, không phải lớp bảo vệ chính — lớp chính là việc ngữ cảnh được CHỌN
 * chứ không quét. Nhưng lưới cuối tồn tại vì lớp chính do người viết, và người thì quên.
 */
const CAM_TUYET_DOI = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "DATABASE_URL",
  "POSTGRES_PASSWORD",
  "AUTH_SECRET",
  "CRON_SECRET",
  "PANCAKE_API_KEY",
  "VIETTELPOST_API_KEY",
  "VIETTELPOST_PASSWORD",
  "FACEBOOK_ACCESS_TOKEN",
  "SEPAY_API_TOKEN",
  "SEPAY_WEBHOOK_SECRET",
  "ADMIN_PASSWORD",
  "ERP_GITHUB_TOKEN",
] as const;

export function promptCoSecretKhong(prompt: string): string | null {
  for (const k of CAM_TUYET_DOI) {
    if (prompt.includes(k)) return k;
  }
  /* Giá trị của một khoá đang đặt trên máy cũng không được lọt vào, kể cả khi tên biến không xuất hiện. */
  for (const k of CAM_TUYET_DOI) {
    const v = (process.env[k] ?? "").trim();
    if (v.length >= 8 && prompt.includes(v)) return `${k} (giá trị)`;
  }
  return null;
}

const HE_THONG = `Bạn là AI CTO của một ERP thương mại điện tử thời trang đang chạy thật (VNXcommerce).

VIỆC CỦA BẠN: đọc MỘT mục tiêu kỹ thuật và đề nghị cách chia nó thành các việc nhỏ làm được.

BẠN KHÔNG LÀM: không viết mã, không tạo việc, không giao người, không duyệt, không merge, không
deploy. Đề nghị của bạn phải được một con người bấm duyệt mới thành việc thật.

BỐN LUẬT NGHIỆP VỤ KHÔNG ĐƯỢC PHẠM (trích AGENTS.md mục 0):
1. Logistics, tiền và tồn kho là ba chiều RIÊNG, không suy ra lẫn nhau. Không bao giờ kết luận
   "giao thành công" từ tiền, COD hay trạng thái Pancake.
2. Chỉ có MỘT công thức kết quả đơn: ORDER_OUTCOME trong lib/queries/return-rate.ts. Mọi báo cáo
   dùng lại nó, không tự tính.
3. NULL là CHƯA BIẾT, không phải 0.
4. Hàng hoàn không tự vào tồn cho tới khi kho xác nhận thực nhận.

VỀ MỨC RỦI RO: bạn chỉ NÊU Ý KIẾN và giải thích. Mức rủi ro CUỐI do máy xếp lại lúc duyệt, bạn
không quyết được. Việc chạm lương, tiền, quyền, migration, công thức báo cáo thì nói thẳng là rủi
ro cao và giải thích vì sao — đừng hạ mức để kế hoạch trông dễ chịu.

KHI THIẾU DỮ LIỆU: đưa vào "questions". Đừng đoán rồi viết như thể đã biết.

TRẢ LỜI: CHỈ một khối JSON hợp lệ, không văn xuôi ngoài JSON, không hàng rào markdown.`;

function moTaVai(): string {
  return TECH_AGENT_TEMPLATES.map(
    (t) => `- ${t.key} (${t.role}): ${t.description} · rủi ro được phép: ${t.allowedRisks.join("/")} · viết mã: ${t.canCode ? "có" : "không"}`,
  ).join("\n");
}

function luocDoJson(): string {
  return `{
  "summary": "một đoạn nói kế hoạch này giải quyết gì",
  "assumptions": ["giả định bạn đã đặt"],
  "questions": ["câu bạn cần người trả lời"],
  "tasks": [
    {
      "key": "T1",
      "title": "…",
      "description": "…",
      "taskType": ${JSON.stringify(TECH_TASK_TYPES)},
      "module": ${JSON.stringify(TECH_MODULES)},
      "suggestedPriority": "P0|P1|P2|P3",
      "suggestedRisk": "R0|R1|R2",
      "riskExplanation": "vì sao bạn nghĩ mức đó",
      "suggestedAgent": ${JSON.stringify(CTO_AGENT_KEYS)},
      "dependsOn": ["khoá việc phải xong trước"],
      "acceptanceCriteria": ["đo được, không phải 'chạy tốt'"],
      "expectedScope": ["thư mục/mô-đun sẽ chạm"],
      "needsHumanDecision": false,
      "humanDecisionNote": ""
    }
  ]
}

Tối đa ${CTO_MAX_TASKS} việc. Trường taskType và module phải lấy ĐÚNG một giá trị trong danh sách
trên. suggestedAgent phải là một khoá trong danh sách vai.`;
}

export type CtoContext = { prompt: string; blocked: string | null };

/** Dựng prompt cho một mục tiêu. Tách khỏi lượt gọi model để kiểm được mà không tốn tiền. */
export async function buildCtoPrompt(sourceTaskId: string, repoRoot = process.cwd()): Promise<CtoContext | null> {
  const db = await getDb();
  const task = await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, sourceTaskId) });
  if (!task) return null;

  const cungModule = await db.query.techTasks.findMany({
    where: and(eq(schema.techTasks.module, task.module), ne(schema.techTasks.id, task.id)),
    orderBy: [desc(schema.techTasks.createdAt)],
    limit: 15,
  });
  const suCo = await db.query.techIncidents.findMany({
    where: inArray(schema.techIncidents.status, ["OPEN", "MITIGATED"]),
    orderBy: [desc(schema.techIncidents.createdAt)],
    limit: 5,
  });
  const deploy = await db.query.techDeployments.findMany({ orderBy: [desc(schema.techDeployments.startedAt)], limit: 3 });

  /* Cây thư mục ở mức MÔ-ĐUN. Liệt kê từng tệp là nhồi vài nghìn dòng vô ích vào prompt. */
  let cay = "";
  try {
    const { readdirSync } = await import("node:fs");
    const gom = (d: string) =>
      readdirSync(path.join(repoRoot, d), { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => `${d}/${e.name}`)
        .join(", ");
    cay = ["app", "lib", "components"].map((d) => `${d}/: ${gom(d)}`).join("\n");
  } catch {
    cay = "(không đọc được cây thư mục)";
  }

  let luat = "";
  try {
    luat = readFileSync(path.join(repoRoot, "docs/business-rules/ORDER_OUTCOME.md"), "utf8").slice(0, 3000);
  } catch {
    luat = "(không đọc được đặc tả kết quả đơn)";
  }

  const prompt = [
    `MỤC TIÊU (${task.code}): ${task.title}`,
    task.description ? `\nMÔ TẢ:\n${task.description}` : "",
    `\nMODULE: ${task.module} · LOẠI: ${task.taskType} · ƯU TIÊN: ${task.priority} · RỦI RO MÁY XẾP: ${task.risk}`,
    `\nVAI AGENT CÓ THẬT:\n${moTaVai()}`,
    cungModule.length ? `\nVIỆC KHÁC ĐANG MỞ TRONG CÙNG MODULE:\n${cungModule.map((t) => `- ${t.code} [${t.status}/${t.risk}] ${t.title}`).join("\n")}` : "",
    suCo.length ? `\nSỰ CỐ ĐANG MỞ:\n${suCo.map((i) => `- ${i.code ?? i.id}: ${i.title}`).join("\n")}` : "",
    deploy.length ? `\nLƯỢT DEPLOY GẦN NHẤT:\n${deploy.map((d) => `- ${d.commitSha.slice(0, 12)} ${d.status} (${d.verification})`).join("\n")}` : "",
    `\nCÂY MÔ-ĐUN:\n${cay}`,
    `\nTRÍCH ĐẶC TẢ KẾT QUẢ ĐƠN (đọc trước khi đề nghị bất cứ việc gì chạm đơn/tiền/tồn kho):\n${luat}`,
    `\nTRẢ VỀ ĐÚNG LƯỢC ĐỒ NÀY:\n${luocDoJson()}`,
  ]
    .filter(Boolean)
    .join("\n");

  return { prompt, blocked: promptCoSecretKhong(prompt) };
}

/**
 * Dịch một lỗi của nhà cung cấp sang câu mà người đọc LÀM ĐƯỢC gì đó với nó.
 *
 * Nguyên văn phong bì lỗi — `{"type":"error","error":{"type":"overloaded_error",…}}` — đúng nhưng
 * câm: nó không nói cho người đọc biết đây là lỗi của ta, của khoá, hay của bên kia, mà ba thứ đó
 * sửa ở ba chỗ hoàn toàn khác nhau (AGENTS.md mục 55). Vẫn giữ nguyên văn ở cuối câu để còn tra
 * `request_id` khi cần hỏi nhà cung cấp.
 */
function doiLoiGoiModel(e: unknown): string {
  const raw = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 400);
  const status = typeof (e as { status?: unknown } | null)?.status === "number" ? ((e as { status: number }).status) : null;
  if (status === 529 || /overloaded/i.test(raw)) {
    return `Nhà cung cấp đang QUÁ TẢI và đã hết lượt thử lại. Không phải lỗi mã nguồn, không phải lỗi khoá — chạy lại sau ít phút. Nguyên văn: ${raw}`;
  }
  if (status === 401 || status === 403 || /unauthor|invalid[_ ]?api[_ ]?key|authentication/i.test(raw)) {
    return `Khoá API bị từ chối. Thay khoá trên máy runner. Nguyên văn: ${raw}`;
  }
  if (status === 429 || /rate[_ ]?limit|quota|credit balance|insufficient/i.test(raw)) {
    return `Hết hạn mức hoặc hết tín dụng. Không phải lỗi mã nguồn. Nguyên văn: ${raw}`;
  }
  if (/timed out|timeout|aborted/i.test(raw)) {
    return `Lượt gọi hết giờ trước khi model trả lời xong. Nguyên văn: ${raw}`;
  }
  return `Gọi model hỏng: ${raw}`;
}

export type CtoRunResult =
  | { ok: true; plan: CtoPlan; provider: string; model: string; raw: unknown }
  | { ok: false; error: string; provider: string; model: string; raw: unknown };

/**
 * Gọi model THẬT và đọc bản kế hoạch.
 *
 * Không tool, không vòng lặp: CTO chỉ đọc ngữ cảnh đã chọn rồi trả về một khối JSON. Thêm tool là
 * thêm một đường để nó chạm vào thứ nó không được chạm, cho một việc không cần tới.
 */
export async function runCtoPlanning(provider: AiProvider, ctx: CtoContext): Promise<CtoRunResult> {
  const meta = { provider: provider.name, model: provider.model };
  if (ctx.blocked) {
    return { ok: false, error: `Từ chối gọi model: prompt chứa \`${ctx.blocked}\` — bí mật không bao giờ được rời máy chủ.`, ...meta, raw: null };
  }
  let text = "";
  try {
    const res = await provider.complete({
      system: HE_THONG,
      messages: [{ role: "user", content: [{ type: "text", text: ctx.prompt }] }],
      tools: [],
      maxTokens: CTO_MAX_OUTPUT_TOKENS,
    });
    text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    // Chạm trần token ⇒ câu trả lời bị CẮT, và một chuỗi JSON cụt luôn hỏng cú pháp. Để nó đi tiếp
    // xuống bộ đọc là in ra "không đọc được JSON" — câu đó đẩy người sửa đi soi prompt và lược đồ
    // trong khi chỗ hỏng là cái trần của chính ta. Chặn ngay tại đây, gọi đúng tên.
    if (res.stopReason === "max_tokens") {
      return {
        ok: false,
        error: `Câu trả lời bị cắt: chạm trần ${CTO_MAX_OUTPUT_TOKENS.toLocaleString("vi-VN")} token (${text.length.toLocaleString("vi-VN")} ký tự đã nhận). Đây KHÔNG phải lỗi định dạng của model — hoặc nới trần, hoặc thu hẹp mục tiêu.`,
        ...meta,
        raw: text.slice(0, 20_000),
      };
    }
    if (res.stopReason === "refusal") {
      return { ok: false, error: "Model từ chối trả lời vì chính sách nội dung. Không có bản kế hoạch nào được lập.", ...meta, raw: text.slice(0, 20_000) };
    }
  } catch (e) {
    return { ok: false, error: doiLoiGoiModel(e), ...meta, raw: null };
  }
  const parsed = parseCtoPlan(text);
  if (!parsed.ok) return { ok: false, error: parsed.error, ...meta, raw: text.slice(0, 20_000) };
  return { ok: true, plan: parsed.plan, ...meta, raw: parsed.plan };
}
