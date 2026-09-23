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

VÀ ĐỪNG VIẾT MỘT ĐỀ BÀI BẢO NGƯỜI KHÁC KẾT LUẬN TỪ SỰ VẮNG MẶT. Luật trên áp cho chính bạn; luật
này áp cho thứ bạn GIAO ĐI. "Không tìm thấy X" và "X không tồn tại" là hai câu khác hẳn nhau về
hậu quả: câu đầu bảo đi tìm tiếp, câu sau bảo thôi. Một đề bài viết "nếu không có bằng chứng thì
ghi thẳng là không liên quan" biến một phép tìm CHƯA XONG thành một kết luận ĐÃ CHỐT — và người
đọc báo cáo sau đó không có cách nào biết chỗ ấy chưa ai tìm tới.

Đã xảy ra thật (việc TECH-9, 23/09/2026): đề bài do chính bạn sinh ra nói "nếu không có bằng chứng
thì ghi thẳng là không liên quan". Agent làm ĐÚNG lời dặn và giao về một mục mang tiêu đề "KHÔNG
LIÊN QUAN", trong khi thân mục ấy tự nói rằng nó chỉ đọc được 500 dòng log. Lỗi ở LỜI DẶN, không ở
agent.

Nên tiêu chí nghiệm thu phải đòi ba thứ, không phải một câu có/không:
  · điều đã tìm thấy,
  · PHẠM VI đã tìm (bao nhiêu dòng log, khoảng thời gian nào, bảng nào),
  · và CÁI GÌ sẽ giải quyết dứt điểm nếu chưa đủ.
Chưa đủ căn cứ thì kết quả đúng là "CHƯA TÌM THẤY BẰNG CHỨNG" kèm phạm vi — không bao giờ là một
kết luận phủ định.

GIỚI HẠN CỨNG: "tasks" phải có TỪ 1 TỚI ${CTO_MAX_TASKS} phần tử. Từ ${CTO_MAX_TASKS + 1} trở lên thì TOÀN BỘ bản kế
hoạch bị từ chối — không phải bị cắt bớt, là bị bỏ cả bản. Thấy cần nhiều bước hơn thì GỘP các
bước cài đặt liên quan vào MỘT việc với NHIỀU tiêu chí nghiệm thu, đừng đẻ thêm việc. Giới hạn này
là kiến trúc của một bản kế hoạch, không phải một con số cản đường.

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

Nhắc lại GIỚI HẠN CỨNG: "tasks" có TỪ 1 TỚI ${CTO_MAX_TASKS} phần tử, không hơn. Trường taskType và module
phải lấy ĐÚNG một giá trị trong danh sách trên. suggestedAgent phải là một khoá trong danh sách vai.
Mọi khoá trong dependsOn phải trỏ tới một task có thật trong chính bản này.`;
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

/** Bằng chứng về lượt gọi: đếm được, và phân biệt được lượt đầu với lượt sửa. */
export type CtoAttempts = {
  /** 0 = bị chặn trước khi gọi · 1 = lượt đầu đã đạt · 2 = đã sửa một lần. Trần là 2. */
  modelCalls: 0 | 1 | 2;
  /** Lượt ĐẦU sai cái gì. Rỗng = lượt đầu đạt, hoặc chưa gọi được lượt nào. */
  initialError: string;
  repairOutcome: "NONE" | "PASS" | "FAIL";
};

export type CtoRunResult =
  | ({ ok: true; plan: CtoPlan; provider: string; model: string; raw: unknown } & CtoAttempts)
  | ({ ok: false; error: string; provider: string; model: string; raw: unknown } & CtoAttempts);

/**
 * Một lượt gọi model, phân làm hai loại — và ranh giới này QUYẾT ĐỊNH có được sửa hay không.
 *
 *   · `TEXT` — model đã nói xong một câu trả lời. Câu đó có thể sai hợp đồng, và SAI HỢP ĐỒNG LÀ
 *     THỨ DUY NHẤT sửa được: ta cầm đúng chỗ sai đưa lại cho chính model.
 *   · `CHAN` — không có câu trả lời nào để mà sửa: khoá bị từ chối, hết hạn mức, nhà cung cấp quá
 *     tải, hết giờ, model từ chối vì chính sách, hoặc câu trả lời bị CẮT vì chạm trần token của
 *     ta. Gọi lại lần nữa ở những nhánh này chỉ là nhân đôi một lượt hỏng — và với 429 thì còn
 *     là đổ thêm dầu vào đúng cái đang cháy.
 */
type LuotGoi = { kind: "TEXT"; text: string } | { kind: "CHAN"; error: string; raw: string | null };

async function goiModel(provider: AiProvider, prompt: string): Promise<LuotGoi> {
  let text = "";
  try {
    const res = await provider.complete({
      system: HE_THONG,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      tools: [],
      maxTokens: CTO_MAX_OUTPUT_TOKENS,
    });
    text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    // Chạm trần token ⇒ câu trả lời bị CẮT, và một chuỗi JSON cụt luôn hỏng cú pháp. Để nó đi tiếp
    // xuống bộ đọc là in ra "không đọc được JSON" — câu đó đẩy người sửa đi soi prompt và lược đồ
    // trong khi chỗ hỏng là cái trần của chính ta. Chặn ngay tại đây, gọi đúng tên. Và KHÔNG sửa:
    // chỗ hỏng không nằm ở model, nên bảo model viết lại thì nó lại bị cắt y như vậy.
    if (res.stopReason === "max_tokens") {
      return {
        kind: "CHAN",
        error: `Câu trả lời bị cắt: chạm trần ${CTO_MAX_OUTPUT_TOKENS.toLocaleString("vi-VN")} token (${text.length.toLocaleString("vi-VN")} ký tự đã nhận). Đây KHÔNG phải lỗi định dạng của model — hoặc nới trần, hoặc thu hẹp mục tiêu.`,
        raw: text.slice(0, 20_000),
      };
    }
    if (res.stopReason === "refusal") {
      return { kind: "CHAN", error: "Model từ chối trả lời vì chính sách nội dung. Không có bản kế hoạch nào được lập.", raw: text.slice(0, 20_000) };
    }
  } catch (e) {
    return { kind: "CHAN", error: doiLoiGoiModel(e), raw: null };
  }
  return { kind: "TEXT", text };
}

/** Cắt bản cũ cho vừa một lượt gọi. Đủ để model thấy nó đã viết gì, không đủ để thổi đôi prompt. */
const TRAN_BAN_CU = 12_000;

/**
 * Prompt sửa lỗi.
 *
 * Nó KHÔNG xin một bản kế hoạch mới — xin mới là ném đi phần đã đúng rồi cầu may lần nữa. Nó đưa
 * lại ĐÚNG BA thứ: lỗi kiểm tra nguyên văn, hợp đồng, và bản model vừa viết; rồi đòi TOÀN BỘ JSON
 * đã sửa. Toàn bộ, chứ không phải một mảnh vá: một mảnh vá buộc phía ta phải ghép lại, mà ghép
 * chính là "tự sửa dependency" — thứ mục 4 cấm.
 */
function promptSuaLoi(banCu: string, loi: string): string {
  return [
    "Bản JSON bạn vừa trả về KHÔNG ĐẠT hợp đồng.",
    "",
    `LỖI KIỂM TRA: ${loi}`,
    "",
    "CÁCH SỬA:",
    `- tasks phải có TỪ 1 TỚI ${CTO_MAX_TASKS} phần tử. Thừa thì GỘP các việc gần nhau lại thành một`,
    "  việc kèm nhiều tiêu chí nghiệm thu — ĐỪNG xoá bớt mục tiêu để cho vừa số.",
    "- Sau khi gộp, sửa lại dependsOn: mọi khoá phải trỏ tới một task CÒN TỒN TẠI trong bản mới,",
    "  không tự trỏ vào chính nó, và không tạo thành vòng.",
    "- taskType, module, suggestedPriority, suggestedRisk, suggestedAgent phải lấy ĐÚNG một giá trị",
    "  trong danh sách đã cho.",
    "- Giữ nguyên summary, assumptions, questions trừ khi chính chúng bị báo lỗi.",
    "",
    "TRẢ VỀ TOÀN BỘ JSON ĐÃ SỬA, không phải một phần. Không văn xuôi ngoài JSON, không hàng rào markdown.",
    "",
    "BẢN JSON TRƯỚC:",
    banCu.slice(0, TRAN_BAN_CU),
  ].join("\n");
}

/**
 * Gọi model THẬT và đọc bản kế hoạch, với ĐÚNG MỘT lượt sửa khi đầu ra không đạt hợp đồng.
 *
 * Không tool, không vòng lặp: CTO chỉ đọc ngữ cảnh đã chọn rồi trả về một khối JSON. Thêm tool là
 * thêm một đường để nó chạm vào thứ nó không được chạm, cho một việc không cần tới.
 *
 * ─── VÌ SAO SỬA, VÀ VÌ SAO CHỈ MỘT LẦN ───
 *
 * Đã xảy ra thật (production, 19/09/2026): model trả 13 việc cho hợp đồng tối đa 12. Có ba cách
 * xử, và hai trong số đó sai:
 *
 *   ✗ Nâng trần lên 13. Trần 12 là giới hạn KIẾN TRÚC của một bản kế hoạch, không phải một con số
 *     cản đường. Nâng nó để model pass là để model định nghĩa lại hợp đồng.
 *   ✗ `tasks.slice(0, 12)`. Trông gọn và hỏng ngầm: `dependsOn` của việc còn lại trỏ vào việc vừa
 *     bị xoá, tiêu chí nghiệm thu mất mảng, và bản kế hoạch qua được zod trong khi ý nghĩa đã sai.
 *     Một bản sai mà hợp lệ tệ hơn hẳn một bản bị từ chối.
 *   ✓ Đưa lỗi lại cho chính model và bắt nó GỘP. Nó là bên duy nhất biết việc nào gộp được với
 *     việc nào.
 *
 * Một lần, không hơn. Sửa lần hai gần như luôn là model đang lặp lại cùng một hiểu nhầm, và mỗi
 * vòng thêm là thêm tiền, thêm thời gian chờ, thêm một lần người đọc log phải đoán xem cái đang
 * chạy là lượt thứ mấy. Hỏng sau lượt sửa thì bản đề xuất nằm ở `DRAFT` kèm lỗi cuối — người đọc
 * thấy cả lỗi ban đầu lẫn kết quả sửa, và tự quyết.
 */
export async function runCtoPlanning(provider: AiProvider, ctx: CtoContext): Promise<CtoRunResult> {
  const meta = { provider: provider.name, model: provider.model };
  const chuaGoi: CtoAttempts = { modelCalls: 0, initialError: "", repairOutcome: "NONE" };
  if (ctx.blocked) {
    return {
      ok: false,
      error: `Từ chối gọi model: prompt chứa \`${ctx.blocked}\` — bí mật không bao giờ được rời máy chủ.`,
      ...meta,
      raw: null,
      ...chuaGoi,
    };
  }

  /* ───── LƯỢT 1 ───── */
  const luot1 = await goiModel(provider, ctx.prompt);
  if (luot1.kind === "CHAN") {
    // Không có câu trả lời nào để sửa. Gọi lại là nhân đôi một lượt hỏng.
    return { ok: false, error: luot1.error, ...meta, raw: luot1.raw, modelCalls: 1, initialError: "", repairOutcome: "NONE" };
  }
  const doc1 = parseCtoPlan(luot1.text);
  if (doc1.ok) {
    return { ok: true, plan: doc1.plan, ...meta, raw: doc1.plan, modelCalls: 1, initialError: "", repairOutcome: "NONE" };
  }

  /* ───── LƯỢT 2: ĐÚNG MỘT lượt sửa, và vẫn qua CÙNG một bộ kiểm ───── */
  const luot2 = await goiModel(provider, promptSuaLoi(luot1.text, doc1.error));
  if (luot2.kind === "CHAN") {
    return {
      ok: false,
      error: `Lượt sửa không gọi được model: ${luot2.error} · Lỗi ban đầu: ${doc1.error}`,
      ...meta,
      raw: luot1.text.slice(0, 20_000),
      modelCalls: 2,
      initialError: doc1.error,
      repairOutcome: "FAIL",
    };
  }
  // CÙNG `parseCtoPlan`, không có bộ đọc lỏng tay cho lượt sửa. Một cổng nới ra "chỉ cho lần hai"
  // là một cổng không còn là cổng.
  const doc2 = parseCtoPlan(luot2.text);
  if (doc2.ok) {
    return { ok: true, plan: doc2.plan, ...meta, raw: doc2.plan, modelCalls: 2, initialError: doc1.error, repairOutcome: "PASS" };
  }
  return {
    ok: false,
    error: `Sửa một lượt vẫn không đạt — ${doc2.error} · Lỗi ban đầu: ${doc1.error}`,
    ...meta,
    raw: luot2.text.slice(0, 20_000),
    modelCalls: 2,
    initialError: doc1.error,
    repairOutcome: "FAIL",
  };
}
